# CLAUDE.md — The Bot Crew Agent Platform

> This file is the project's persistent memory. Read it at the start of every session.
> Keep it current: when an architectural decision, convention, or workflow changes,
> update this file in the same change.
>
> **Business rules** (what the bot does and why — reply gating, follow-up cadence, quiet
> hours, availability rules, handoff) live in [`docs/business-logic.md`](docs/business-logic.md).
> Read it before changing agent behavior, and update it in the same change — same rule as here.

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

Turn durability: the agent run is debounced 15s in `waitUntil` (coalesces rapid multi-message
bursts into one reply). If that's dropped (isolate
eviction, transient model/GHL failure), a **reconciliation cron** (`worker/reconciliation.ts`,
runs each minute) finds conversations whose latest message is an unanswered inbound (>45s old,
active, gates pass) and re-runs the turn — recovering within ~1 min. The atomic claim
(`reconcile_claimed_at`, FOR UPDATE SKIP LOCKED + cooldown) + the latest-message gate prevent
double-replies. (Cloudflare Queues would be the heavier "correct" upgrade — deferred.)

We own conversation history, including message content + who sent what (lead vs which AI
role vs which human agent) — the foundation for future human-agent ↔ AI collaboration.
Tenant data is isolated with Postgres row-level security (deny-by-default on `tenants`,
`tenant_config`, `conversations`, `messages`; the Worker uses the service-role key, which
bypasses RLS).

### Hybrid config: code vs database
- **Code = the product.** Role definitions, system-prompt templates, tool
  implementations, and orchestration live in git. Editing them ships to all clients.
- **Database = per-tenant variables.** Business name, services, hours, calendar IDs,
  FAQ, tone overrides, which roles are enabled, provider/model, follow-up tiers,
  follow-up quiet hours (`quiet_hours` jsonb `{start,end}` local, NULL = platform default
  21:00–08:00), and the reply gates (`enabled_channels`, `test_contact_ids`,
  `trigger_keywords` — see GHL notes) live in Supabase. Onboarding a client
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
      reactivation/            # text-only follow-up/reactivation agent (no tools)
    ghl/                       # webhook parse/verify, OAuth, tags + transport-only API client (live)
    db/                        # service-role Supabase client, queries (config read + RPC writes)
    worker/                    # webhook-handler (inbound) + outbound-handler (human takeover) + tag-handler (bot-off) + delivery-retry + followup-runner + reconciliation (dropped-turn backstop)
  scripts/simulate-webhook.mjs # local dev: fire a fake GHL webhook
  fixtures/                    # sample webhook payloads
  wrangler.jsonc, vitest.config.ts, tsconfig.json
supabase/
  migrations/                  # 0001–0022 (plus 0014a–d backfilled from prod). Core: 0001 init,
                               # 0004 tenant_config, 0005 conversation_store, 0006 ghl_oauth, 0011 debounce,
                               # 0012 follow_ups, 0013 human_takeover, 0014b add_facebook_channel,
                               # 0015 tag_handoff, 0016 channel_control+test_mode, 0017 trigger_keyword_gate,
                               # 0020 turn_reconciliation, 0021 availability_event, 0022 follow_up_quiet_hours
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
3. Install/authorize the GHL Marketplace app for the subaccount (`/oauth/ghl/install`) so a
   per-location OAuth token lands in `ghl_oauth_tokens`. The shared webhook routes by
   `locationId` — no per-tenant webhook config needed.
4. **Go-live gates** (a new tenant is silent by default — `enabled_channels` is NULL):
   test with `test_contact_ids` (your own contacts) first, then set `enabled_channels`
   (e.g. `{facebook}`) to go live. Optionally set `trigger_keywords` for ad-CTA flows.
   No code change or redeploy required for a standard onboarding.

## Workflows

> Run from the repo root. `pnpm install` once first. Secrets: copy
> `workers/.dev.vars.example` → `workers/.env` (for `mastra dev`) and fill it in.

### Local dev
```bash
supabase start && supabase db reset      # applies all migrations (0001–0017) + seeds demo tenant
pnpm dev                                  # mastra dev — Worker + /webhooks/ghl route (port 4111)
pnpm webhook:simulate                     # POST workers/fixtures/ghl-inbound.example.json
```
Fire `webhook:simulate` twice to confirm turn 2 sees turn 1 as history (loaded from our
DB). Inspect `messages` — rows carry `content`, `sender_type`, `agent_role`. GHL send is a
**real** API call now: it uses the tenant's stored OAuth token, falling back to
`GHL_API_TOKEN`; with no token the send fails and the row is left `delivery_status='pending'`
for the retry cron.

### Tests & evals
- Reliability is a first-class feature (we moved off n8n for exactly this reason).
- **`pnpm test:unit`** — deterministic unit + orchestration tests (`*.test.ts`), **no API
  key / no network / no DB**. Layer 1: webhook parsers + signature verification (`verifyDetached`
  round-trip with a generated keypair) + the gate helpers / keyword matcher. Layer 2: mock
  `db/queries` + `GhlClient` + the agent and drive `handleInboundWebhook` (dedup, suppression,
  channel/keyword gates, happy path, delivery failure). **This is the CI gate** (`.github/workflows/ci.yml`
  runs typecheck + `test:unit` on every push/PR, no keys).
- **`pnpm eval`** — adds the role eval cases (`*.eval.ts`): offline (prompt) cases always run;
  live (model-calling) golden cases run only when `OPENAI_API_KEY`/`ANTHROPIC_API_KEY` is set.
- Run `pnpm test:unit` before any change to orchestration/parsing, and `pnpm eval` before a
  change to a role's prompt or tools. (Layer 3 golden-conversation gate on staging: TBD.)

### Deploy
- `pnpm typecheck` + `pnpm test:unit` (the gate) then `pnpm build` (mastra build via
  CloudflareDeployer) → `pnpm --filter @thebotcrew/workers exec wrangler deploy`. Set Worker
  secrets with `wrangler secret put <NAME>` (see `.env.example`). Staging step TBD.

## GHL integration notes

- Inbound: parse the webhook payload; the subaccount/location id identifies the tenant.
- Outbound: send replies and create bookings via the GHL API. **Transport only** — we do
  NOT read conversation history from GHL (it lives in our DB).
- Channels: FB / IG / WhatsApp all work. Inbound channel comes from the webhook
  `messageType` (`FB`/`IG`/`WhatsApp`, normalized in `ghl/webhook.ts`); outbound sends with
  the matching `type`. FB/IG have no phone — delivery routes by `contactId`, and a real
  inbound (FB/IG/WhatsApp messaging window) must be open for GHL to deliver.
- Human takeover (hybrid): a human reply (`source:'app'` outbound webhook) opens a 5-min
  sliding pause; `status='handed_off'` is a permanent pause. Both are enforced by
  `isBotSuppressed`, re-checked again right before send (anti-double-message).
- Tag kill switch: the `bot-off` tag on a GHL contact = permanent handoff; removing it
  resumes the bot (no `bot-on` tag — absence means on). Wired via the **ContactTagUpdate**
  webhook → `/webhooks/ghl/tags` → `worker/tag-handler.ts` (contact-scoped: resolves by
  `ghl_contact_id`). The bot also writes tags when IT sets a status (`ghl/tags.ts`
  `STATUS_TAGS`), so state stays visible/synced in GHL. **Requires the `contacts.write`
  scope** (`ghl/oauth.ts`) — adding it means tenants must re-authorize the Marketplace app.
- Webhook routes (configure in the Marketplace app): InboundMessage → `/webhooks/ghl`,
  OutboundMessage → `/webhooks/ghl/outbound`, ContactTagUpdate → `/webhooks/ghl/tags`.
- Per-tenant reply gating (`tenant_config`, enforced in `webhook-handler.ts`; inbound is
  always stored — only the *reply* is gated):
  - `enabled_channels text[]` — channels the bot may reply on. **`NULL` = none** (installed
    but silent; the onboarding default — new rows are born NULL). Existing tenants were
    backfilled to all three. Set e.g. `{facebook}` to go live on one channel.
  - `test_contact_ids text[]` — pre-live test allowlist. When non-empty, the bot replies
    **only** to those GHL contact ids, on **any** channel (bypasses the channel gate).
  - `trigger_keywords text[]` — entry-gate keywords (e.g. ad CTA "manda Agente"). When
    non-empty, the bot only **enters** a conversation whose message contains a keyword
    (whole-word/phrase, case- & accent-insensitive). It's an entry gate, not per-message:
    once activated (`conversations.bot_activated`), the thread flows without the keyword.
    Helpers: `channelEnabled` / `inTestMode` / `hasTriggerKeywords` / `messageMatchesTrigger`
    (`core/tenant.ts`); gate order in `webhook-handler.ts`: channel/test → keyword.
- Resolved: inbound payload shape (`type=InboundMessage`, `direction=inbound`,
  `locationId/contactId/conversationId/body/messageType`), send/calendar/tag endpoints
  (live in `ghl/client.ts`), and the **auth model** — per-location **OAuth** via the GHL App
  Marketplace, tokens in `ghl_oauth_tokens`, install/authorize at `/oauth/ghl/install`,
  auto-refreshed. Scopes in `ghl/oauth.ts`.
- **Webhook verification (live):** every webhook is verified over its RAW body in the route
  handler **before** parse — Ed25519 (`x-ghl-signature`, current) with RSA-SHA256
  (`x-wh-signature`, legacy, GHL-deprecated 2026-07-01) fallback, against GHL's published
  public keys (embedded in `ghl/webhook.ts`, `verifyGhlWebhook`). Fails closed → 401, no DB
  write / no agent run. Local-dev bypass: `ALLOW_UNVERIFIED_WEBHOOKS=true` (off in prod, so
  `webhook:simulate` needs it set in `.dev.vars`).

## Models

- Provider and model are per-tenant, with platform-level defaults (`DEFAULT_PROVIDER` /
  `DEFAULT_MODEL` in `roles/front-desk/agent.ts`).
- Platform default: `openai` / `gpt-5-mini` (raised from `gpt-4o-mini` — the older mini
  contradicted its own availability slot list; see `bot_events.availability_checked`).
  Per-tenant override stored in `tenant_config.ai_provider` + `tenant_config.ai_model`.
- Both `@ai-sdk/openai` and `@ai-sdk/anthropic` are installed. The agent creates the right
  provider at request time via `getAiApiKey(provider)` reading `OPENAI_API_KEY` or
  `ANTHROPIC_API_KEY` from Worker secrets. Keys never touch the DB.

## Working with me (Leo)

- Plan first: for non-trivial work, propose the file tree / interfaces and wait for my OK
  before generating files.
- Be opinionated. Flag anything risky or irreversible and ask before doing it.
- Prefer direct, concrete guidance over hedged options.
- Default language for client-facing agent content is Spanish.
