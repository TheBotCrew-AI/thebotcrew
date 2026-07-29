# CLAUDE.md — The Bot Crew Agent Platform

> This file is the project's persistent memory. Read it at the start of every session.
> Keep it current: when an architectural decision, convention, or workflow changes,
> update this file in the same change.
>
> **Business rules** (what the bot does and why — reply gating, follow-up cadence, quiet
> hours, availability rules, handoff) live in [`docs/business-logic.md`](docs/business-logic.md).
> Read it before changing agent behavior, and update it in the same change — same rule as here.
>
> ✅ **Durable Objects migration — turn durability: DONE.** Turns run through the
> per-conversation `ConversationDO` (serialized + durable 15s Alarm) for all tenants
> (`DO_TURNS=*`). **Phase 3 cleanup shipped (2026-07-03):** the redundant reconciliation cron,
> the `reconcile_claimed_at` claim, and their RPC/column were deleted (migration 0030) after
> monitoring confirmed the DO handles 100% of turns with no recovery re-runs. The `waitUntil`
> fall-through + `DO_TURNS` flag stay as a cheap rollback belt. Only the **optional** Phase 2
> (retire the follow-up polling cron) remains — defer indefinitely. See
> [`docs/durable-objects-migration.md`](docs/durable-objects-migration.md).

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

Turn durability: **turns now run through a per-conversation Durable Object** (`ConversationDO`,
`worker/conversation-do.ts`) — live for **all** tenants (`DO_TURNS=*`; see the flag
`doTurnsEnabled` in `webhook-handler.ts`). The inbound webhook does the gates + logs the inbound,
then calls `ConversationDO.scheduleTurn()`, which stores the turn and arms a **durable 15s Alarm**
(each new inbound resets it → debounce/coalescing). On the alarm the DO runs `runAgentTurn`.
Because a DO instance is single-threaded, all processing for a conversation is **serialized**
(kills the double-run / self-block-on-booking class), and the Alarm is **durable** (kills the
silent-drop class). This is the Durable Objects migration — Phase 1 done; see
[`docs/durable-objects-migration.md`](docs/durable-objects-migration.md).

The old compensating patches were **deleted in Phase 3 (2026-07-03, migration 0030)** once the DO
was proven: the per-minute **reconciliation cron**, the `reconcile_claimed_at` atomic claim
(`claimTurnForProcessing` + its column/RPC). What remains is a **cheap rollback belt**:
`handleInboundWebhook` still has a `waitUntil` **fall-through** used only if the DO call throws, and
the `DO_TURNS` flag can be emptied to fall every tenant back to the legacy `waitUntil` path (no
redeploy). The DO binding reaches the route via `workerEnvStorage` (AsyncLocalStorage) —
`process.env` carries only string secrets, not binding objects.

We own conversation history, including message content + who sent what (lead vs which AI
role vs which human agent) — the foundation for future human-agent ↔ AI collaboration.
Tenant data is isolated with Postgres row-level security: **deny-by-default (RLS on, zero
policies) on every table in `public`** — migration 0032 closed the last six (`clients`,
`appointments`, `bot_events`, `human_agents`, `follow_ups`, `n8n_chat_histories`). The Worker
uses the service-role key, which bypasses RLS. Three rules to keep it shut:
- The reporting views (`client_summary`, `monthly_activity`) are `security_invoker = on` and
  revoked from `anon`/`authenticated`. A view owned by `postgres` **without** `security_invoker`
  bypasses the RLS of its base tables — that was a real leak until 0032.
- The `app_*` RPCs are `SECURITY INVOKER`; EXECUTE is revoked from **`PUBLIC`** (not just from
  `anon` — Postgres grants EXECUTE to `PUBLIC` by default, so revoking from `anon` alone is a
  no-op) and granted explicitly to `service_role`.
- `alter default privileges` revokes table/function grants from `anon`/`authenticated`, so a new
  table doesn't silently reopen the hole. **When the dashboard ships**, add explicit policies +
  grants; don't hand it the service-role key.

### Hybrid config: code vs database
- **Code = the product.** Role definitions, system-prompt templates, tool
  implementations, and orchestration live in git. Editing them ships to all clients.
- **Database = per-tenant variables.** Business name, services, hours, calendar IDs,
  FAQ, tone overrides, which roles are enabled, provider/model, follow-ups (`follow_up_cadence`
  timing ladder + `follow_up_angles` content pool — decoupled, see docs/business-logic.md §4),
  follow-up quiet hours (`quiet_hours` jsonb `{start,end}` local, NULL = platform default
  21:00–08:00), booking horizon (`booking_horizon_days` int, NULL = no cap — deterministically
  clamps getAvailability), the reply gates (`enabled_channels`, `test_contact_ids`,
  `trigger_keywords` — see GHL notes), and the **demo persona** (`demo_on_keywords` /
  `demo_off_keywords` control words + `demo_prompt_overrides` jsonb — see docs/business-logic.md)
  live in Supabase. Onboarding a client is a DB row + config — no redeploy for the common case.

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
    core/                      # role interface + registry, tenant resolver, request-context, env (incl. per-tenant AI key resolution), llm-usage (token normalization), types
    roles/
      front-desk/              # config (zod), prompt (es template), agent, tools/, evals/
      reactivation/            # text-only follow-up/reactivation agent (no tools)
    ghl/                       # webhook parse/verify, OAuth, tags + transport-only API client (live)
    db/                        # service-role Supabase client, queries (config read + RPC writes)
    worker/                    # webhook-handler (inbound) + conversation-do (per-conversation Durable Object: durable-alarm debounce + serialized turn) + outbound-handler (human takeover) + tag-handler (bot-off) + delivery-retry + followup-runner
  scripts/simulate-webhook.mjs # local dev: fire a fake GHL webhook
  fixtures/                    # sample webhook payloads
  wrangler.jsonc, vitest.config.ts, tsconfig.json
supabase/
  migrations/                  # 0001–0022 (plus 0014a–d backfilled from prod). Core: 0001 init,
                               # 0004 tenant_config, 0005 conversation_store, 0006 ghl_oauth, 0011 debounce,
                               # 0012 follow_ups, 0013 human_takeover, 0014b add_facebook_channel,
                               # 0015 tag_handoff, 0016 channel_control+test_mode, 0017 trigger_keyword_gate,
                               # 0020 turn_reconciliation, 0021 availability_event, 0022 follow_up_quiet_hours,
                               # 0023 follow_up_cadence_angles (decouple timing from angle pool), 0024 booking_failed_event,
                               # 0025 booking_horizon, 0026 status_changed_event, 0027 turn_scheduled_event (DO path),
                               # 0028 demo_persona, 0029 demo_started_at (demo clean-start history),
                               # 0030 drop_turn_reconciliation, 0031 conversation_contact_email (merge-recovery key),
                               # 0032 rls_close_data_api (RLS on the last 6 tables + views + RPC grants),
                               # 0033 per_tenant_ai_key_and_llm_usage (ai_key_ref slug + llm_usage/model_pricing + cost view)
  clients.sql, seed-tenants.sql# seeds (run by `supabase db reset` per config.toml)
sites/                         # client marketing sites: static HTML, no build step, no deps
  _template/                   # starting point for a new client
  madi-skincare/               # first client — reference for how far to push identity, not a mold
```

**Migration numbering:** files are `NNNN[a-z]_name.sql` and the CLI keys the ledger on the
`NNNN[a-z]` prefix — **two files sharing a prefix break `supabase start` / `db reset`
outright** (duplicate key on `schema_migrations_pkey`). That was the state of the repo until
2026-07-28, which is why local dry-runs had been impossible and every migration since 0006 was
validated straight against prod. Use a letter suffix (`0013a`, `0014a–d`) when inserting
between numbers. Renaming is safe for prod: prod's ledger uses timestamp versions
(`20260613171711`), not these filenames.

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

> Full procedure, SQL templates, column gotchas and the live-tenant table:
> [`docs/onboarding.md`](docs/onboarding.md). Read that instead of re-deriving it.

Worker base URL (no custom domain yet): `https://thebotcrew-agents.floral-credit-be7e.workers.dev`

1. Insert a `clients` row, a `tenants` row and a `tenant_config` row in Supabase.
2. Fill config: business name, services, hours, calendar IDs, FAQ, tone, enabled roles.
3. Install/authorize the GHL Marketplace app for the subaccount (`<base>/oauth/ghl/install`)
   so a per-location OAuth token lands in `ghl_oauth_tokens`. The shared webhook routes by
   `locationId` — no per-tenant webhook config needed. **Order matters:** the callback
   resolves the tenant by `locationId`, so step 1 must exist first or it 404s
   `unknown_location` and stores no token.
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
- Timezone-safe booking (`bookAppointment` + `tools/booking-time.ts`): the model is NOT trusted
  to build a valid `startTime`. Before booking, the tool **re-queries live availability** and
  books the exact, offset-carrying slot string GHL returned that matches the lead's pick — never
  the model's re-typed string. A request WITH an explicit offset is matched by instant; one
  WITHOUT (the bug class) is matched by tenant-tz **wall-clock**, so a dropped `-07:00` can't be
  read as UTC. No match → the booking is **refused** (`booking_failed` reason `slot_unavailable`),
  the horizon is re-enforced, and the model is told to re-offer a real slot. Fixes the 2026-07-06
  demo bug where "5:15 p.m." (offset dropped) was booked as 10:15 a.m. (read as UTC).
- Contact-merge recovery on send: GHL dedups contacts by phone/email, which can **merge away**
  the `contactId` a webhook gave us (Instant-Form lead whose number already exists as another
  contact) → send fails `CONVERSATIONS_CONTACT_NOT_FOUND`. Crucially the merge **also destroys the
  old `conversationId`** (GHL re-parents the contact to a single new unified conversation), so the
  survivor is found by the keys the merge preserves. `sendMessage` catches the 400 and re-resolves
  the live contactId in order of reliability: **phone → email** (exact `POST /contacts/search`,
  `resolveContactByPhoneOrEmail`) → the conversation object (`getConversationContactId`, last resort
  since it dies with the old contact). It retries once and returns `resolvedContactId` so callers
  persist it (`updateConversationContact`). Wired on all three send paths (turn, delivery-retry cron,
  follow-up). The merge keys are **captured while the contact is still alive** — at inbound and again
  on the first turn's `getContact` — and stored on the conversation (`contact_phone`, `contact_email`
  migration 0031; `setConversationContactKeys`). **Requires the `conversations.readonly` scope**
  (`ghl/oauth.ts`, for the last-resort `GET /conversations/{id}` read — a *different* scope than
  `conversations/message.*`) and `contacts.readonly` (for the search). Tokens issued before
  `conversations.readonly` was added 401 on that read; adding a scope means tenants must
  **re-authorize** the app. This whole path was the bug found 2026-07-06 on The Bot Crew's own FB
  Instant-Form leads: recovery relied only on the (now-dead) conversation lookup **and** lacked the
  scope, so every merged FB lead went unanswered.
- Channels: FB / IG / WhatsApp all work. Inbound channel comes from the webhook
  `messageType` (`FB`/`IG`/`WhatsApp`, normalized in `ghl/webhook.ts`); outbound sends with
  the matching `type`. FB/IG have no phone — delivery routes by `contactId`, and a real
  inbound (FB/IG/WhatsApp messaging window) must be open for GHL to deliver.
- Human takeover (hybrid): a human reply (`source:'app'` outbound webhook) opens a 5-min
  sliding pause; `status='handed_off'` is a permanent pause. Both are enforced by
  `isBotSuppressed`, re-checked again right before send (anti-double-message). **Exception:** a
  `source:'app'` message that is the conversation's FIRST message is a cold-outreach opener (e.g.
  a WhatsApp template on a new contact) — logged but no pause, so the bot answers the lead's reply.
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
  Marketplace, tokens in `ghl_oauth_tokens`, install/authorize at `/oauth/ghl/install`
  (the redirect lands on `/oauth/callback` — that is the path registered in
  `mastra/index.ts` and the one the Marketplace app's `redirect_uri` must match),
  auto-refreshed. Scopes in `ghl/oauth.ts`.
- **Calendar read scopes** (both added 2026-07-22). `calendars/events.write` books/moves/cancels
  and reads `/free-slots`, but grants **no** calendar read — GHL splits those:
  - `calendars.readonly` — lists a location's calendars (`GET /calendars?locationId=`) so
    onboarding can fill `tenant_config.calendars` automatically. Onboarding-only.
  - `calendars/events.readonly` — reads one appointment (`GET /calendars/events/appointments/{id}`
    = `GhlClient.getAppointment`). **This was a live latent bug:** without it that call 401s on
    every tenant, and `lookupAppointment` swallows the error and falls back to our stored
    datetime — so an appointment moved or cancelled directly in the GHL UI was reported to the
    lead at its stale time. (`getContactAppointments`, the newer GHL-sourced fallback, is a
    *contacts* endpoint and works on `contacts.readonly` — only store-sourced appointments went
    stale.)

  Both take effect on new installs after a deploy. Tenants installed earlier keep working but
  keep the stale-appointment behaviour until they **re-authorize**.
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
  provider at request time from the key in the request context.
- **Per-tenant API keys + token accounting** (migration 0033). Goal: know what each client
  costs. Two halves:
  - **Key per tenant.** `tenant_config.ai_key_ref` holds a *slug*, never key material —
    `'MADI'` → Worker secret `OPENAI_API_KEY__MADI` (`aiKeySecretName` normalizes the slug
    into a legal env-var name). `resolveAiApiKey(provider, keyRef)` in `core/env.ts` returns
    `{apiKey, source, fellBack}`; NULL ref = platform key. **Keys still never touch the DB.**
    Recommended provider-side setup: one OpenAI **project** per client (gives cost breakdown
    *and* a per-project spend cap), each issuing its own key.
    - **Missing secret → falls back to the platform key and logs `ai_key_fallback`.** Chosen
      deliberately: a tenant going silent over a misconfigured secret is worse than a month of
      misattributed spend. The fallback is loud, never silent — and the usage row records
      `key_source='platform'`, so reports never claim spend landed on the client's key.
    - Onboarding a tenant with its own key now needs a `wrangler secret put` in addition to
      the DB row — the one case that isn't purely a DB change. See `docs/onboarding.md`.
  - **Token accounting.** `llm_usage` gets one row per model call (`app_log_llm_usage`), with
    input/output/cached tokens, `call_kind`, and `key_source`. All four calls a turn can make
    are covered: the agent, the status classifier, the name extractor, and the reactivation
    follow-up — the last three hit the provider REST APIs directly and were invisible spend.
    `core/llm-usage.ts` normalizes the three usage shapes (AI SDK, OpenAI REST, Anthropic
    REST; Anthropic reports cache reads *outside* `input_tokens`, so they're folded in).
    Writes are fire-and-forget: a lost usage row is a reporting gap, a blocked turn is an outage.
  - **Cost needs prices.** `model_pricing` (USD per 1M tokens, with `effective_from`) is
    filled **by hand** from the provider's pricing page — nothing here guesses a price, and
    `llm_cost_monthly` reports `cost_usd = NULL` for a model with no price row rather than
    inventing one. Loaded so far: `gpt-5-mini` @ $0.25 / $0.025 cached / $2.00 output.
    **A price change is a new row with a new `effective_from`, never an `update`** — the view
    prices each call at the rate in force when the tokens were burned, so an update would
    silently rewrite last month's reports. How to add/read prices:
    [`docs/onboarding.md` § Costs per client](docs/onboarding.md).

## Planned upgrades (future work)

- **Durable Objects migration — turn durability** *(DONE — Phase 1 + Phase 3 shipped)*. Turns run
  on a per-conversation Durable Object with a durable Alarm (serialized + durable), and the
  compensating patches (reconciliation cron + `reconcile_claimed_at` claim) were deleted
  (2026-07-03, migration 0030). Only the **optional** Phase 2 remains — retire the follow-up
  **polling** cron in favour of exact-time DO alarms (elegance, not durability; requires
  multiplexing the DO's single alarm between turn-due and follow-up-due). Recommendation: defer
  indefinitely unless the cron becomes a problem. Full history: [`docs/durable-objects-migration.md`](docs/durable-objects-migration.md).

## Working with me (Leo)

- Plan first: for non-trivial work, propose the file tree / interfaces and wait for my OK
  before generating files.
- Be opinionated. Flag anything risky or irreversible and ask before doing it.
- Prefer direct, concrete guidance over hedged options.
- Default language for client-facing agent content is Spanish.
