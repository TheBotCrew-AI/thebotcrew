# CLAUDE.md — The Bot Crew Agent Platform

> This file is the project's persistent memory. Read it at the start of every session.
> Keep it current: when an architectural decision, convention, or workflow changes,
> update this file in the same change.

## What this is

A multi-tenant platform for building and operating AI agents for service-business
clients (clinics, real estate, gyms — primarily Spanish-speaking SMBs in LATAM). Each
client uses GoHighLevel (GHL) as their CRM/inbox; our agents talk to GHL via inbound
webhooks and the GHL API. The codebase is the product: one deploy serves every client.

The first agent role is **front-desk** (qualify leads, answer FAQs, check availability,
book appointments, follow up). The architecture is designed so additional roles
(follow-up, reactivation, etc.) can be added later as modules and coordinated as a team.

## Stack

- TypeScript, strict mode
- Mastra — agent framework (agents, tools, workflows, memory, evals)
- Cloudflare Workers — runtime; Wrangler for local dev and deploy
- Supabase (Postgres) — two layers: a per-tenant **config** read-layer
  (`tenants`, `tenant_config`) and a **conversation/stats** write-layer
  (`conversations`, `messages` with content + sender attribution, `appointments`,
  `bot_events`, reporting views). pgvector available for future RAG
- GHL — CRM/inbox, integrated via webhooks (inbound) + GHL API (outbound, calendar)
- pnpm — package manager

## Core architecture

### Multi-tenancy
One Worker serves all clients. Request flow:

1. GHL fires an inbound webhook (new message).
2. Resolve the tenant from the payload (GHL location/subaccount id).
3. Load that tenant's config from Supabase.
4. Persist the inbound message to our store; rebuild conversation history from **our**
   DB (not GHL — no API/rate-limit lock-in).
5. Run the appropriate role's agent with that config + history.
6. Persist the outbound reply (with sender attribution: which AI role / model), then
   deliver it via the GHL API (transport only).

We own conversation history, including message content + who sent what (lead vs which AI
role vs which human agent) — the foundation for future human-agent ↔ AI collaboration.
Tenant data is isolated with Postgres row-level security (deny-by-default on `tenants`,
`tenant_config`, `conversations`, `messages`; the Worker uses the service-role key, which
bypasses RLS).

### Hybrid config: code vs database
- **Code = the product.** Role definitions, system-prompt templates, tool
  implementations, and orchestration live in git. Editing them ships to all clients.
- **Database = per-tenant variables.** Business name, services, hours, calendar IDs,
  FAQ, tone overrides, and which roles are enabled live in Supabase. Onboarding a client
  is a DB row + config — no redeploy for the common case.

Prompt templates carry placeholders; tenant config fills them at runtime. Agents only
state facts present in tenant config or returned by tools (anti-hallucination rule).

### Role abstraction
Each business function is a **role** = a Mastra agent + its tools + a config schema,
under `roles/`. Roles follow a uniform interface so new ones plug in without touching the
core. One agent-with-tools per role (not router + specialists). When multiple roles need
to collaborate, coordinate them with Mastra **workflows** — do not merge them into one
mega-agent.

## Repository structure

The agent runtime is a pnpm workspace package in `workers/` (the monorepo also has
`api/` and `dashboard/` reserved for later).

```
workers/                       # Mastra + Cloudflare Worker package (@thebotcrew/workers)
  src/
    mastra/index.ts            # Mastra instance: agents + GHL webhook route + CloudflareDeployer
    core/                      # role interface + registry, tenant resolver, request-context, env, types
    roles/
      front-desk/              # config (zod), prompt (es template), agent, tools/, evals/
    ghl/                       # webhook parse/verify + transport-only API client (stubbed, typed)
    db/                        # service-role Supabase client, queries (config read + RPC writes)
    worker/                    # webhook-handler.ts orchestration
  scripts/simulate-webhook.mjs # local dev: fire a fake GHL webhook
  fixtures/                    # sample webhook payloads
  wrangler.jsonc, vitest.config.ts, tsconfig.json
supabase/
  migrations/                  # 0001 init (stats), 0002/0003 rpc, 0004 tenant_config, 0005 conversation_store
  clients.sql, seed-tenants.sql# seeds (run by `supabase db reset` per config.toml)
```

Two DB layers: **config read-layer** (`tenants`, `tenant_config`) + **conversation/stats
write-layer** (`conversations`, `messages`, `appointments`, `bot_events`, views). Writes
go through the `app_log_*` RPCs; `app_log_message` (0005) stores content + attribution.

## Conventions

- Strict TypeScript. No `any` without a written reason.
- No hardcoded secrets, ever. Use env / Cloudflare secrets; see `.env.example`.
- Every external call (GHL, model, DB) is typed and wrapped with explicit error handling.
- Tenant-specific values never live in code — they come from config.
- Keep changes small and reviewable; record non-obvious decisions in this file.

## How to add a new role

1. Create `workers/src/roles/<role-name>/` following the front-desk role as the reference.
2. Implement: the Mastra agent, its tools, a Spanish-language prompt template with
   config placeholders, and a config schema.
3. Register the role in the role registry.
4. Add eval cases under the role (see "Evals").
5. If it must coordinate with other roles, define a Mastra workflow rather than expanding
   an existing agent.
6. Update this file's repo-structure section.

## How to onboard a new tenant

1. Insert a `tenants` row and a `tenant_config` row in Supabase.
2. Fill config: business name, services, hours, calendar IDs, FAQ, tone, enabled roles.
3. Point the client's GHL subaccount webhook at the Worker.
4. Verify with the local/staging webhook simulation before going live.
   No code change or redeploy required for a standard onboarding.

## Workflows

> Run from the repo root. `pnpm install` once first. Secrets: copy
> `workers/.dev.vars.example` → `workers/.env` (for `mastra dev`) and fill it in.

### Local dev
```bash
supabase start && supabase db reset      # applies migrations 0001–0005 + seeds demo tenant
pnpm dev                                  # mastra dev — Worker + /webhooks/ghl route (port 4111)
pnpm webhook:simulate                     # POST workers/fixtures/ghl-inbound.example.json
```
Fire `webhook:simulate` twice to confirm turn 2 sees turn 1 as history (loaded from our
DB). Inspect `messages` — rows carry `content`, `sender_type`, `agent_role`. GHL send is
stubbed/logged, not a real outbound call.

### Evals
- Reliability is a first-class feature (we moved off n8n for exactly this reason).
- Every role ships with eval cases (under `roles/<role>/evals/`): qualification, booking,
  and anti-hallucination. Offline cases always run; live (model-calling) cases run only
  when `ANTHROPIC_API_KEY` is set.
- Run before any change to a role's prompt or tools: `pnpm eval`.

### Deploy
- `pnpm typecheck` then `pnpm build` (mastra build via CloudflareDeployer) →
  `pnpm --filter @thebotcrew/workers exec wrangler deploy`. Set Worker secrets with
  `wrangler secret put <NAME>` (see `.env.example`). Staging step TBD.

## GHL integration notes

- Inbound: parse the webhook payload; the subaccount/location id identifies the tenant.
- Outbound: send replies and create bookings via the GHL API. **Transport only** — we do
  NOT read conversation history from GHL (it lives in our DB).
- Open questions (block only the real calls, not the stubbed scaffold): exact inbound
  payload JSON, signature/verification scheme, send-message + calendar endpoints, and the
  **auth model** (agency-level token vs per-location OAuth → whether `tenants.ghl_token_ref`
  points at one shared secret or per-tenant tokens). Until answered, GHL calls are stubbed
  but fully typed (`workers/src/ghl/`).

## Models

- Default front-desk model: `claude-sonnet-4-6` (`DEFAULT_MODEL` in
  `roles/front-desk/agent.ts`), resolved per request via `@ai-sdk/anthropic` with the key
  read from the Worker env (not implicit process env — required for Workers). Overridable
  per tenant later.

## Working with me (Leo)

- Plan first: for non-trivial work, propose the file tree / interfaces and wait for my OK
  before generating files.
- Be opinionated. Flag anything risky or irreversible and ask before doing it.
- Prefer direct, concrete guidance over hedged options.
- Default language for client-facing agent content is Spanish.
