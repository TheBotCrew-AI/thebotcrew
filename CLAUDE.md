# CLAUDE.md — The Bot Crew Agent Platform

> This file is the project's persistent memory. Read it at the start of every session.
> Keep it current: when an architectural decision, convention, or workflow changes,
> update this file in the same change.
>
> **Business rules** (what the bot does and why — reply gating, follow-up cadence, quiet
> hours, availability rules, handoff) live in [`docs/business-logic.md`](docs/business-logic.md).
> Read it before changing agent behavior, and update it in the same change — same rule as here.
>
> **How config becomes a prompt** — the code/DB split, which override layer wins, prompt
> assembly order, and the gates — is diagrammed in [`docs/config-model.md`](docs/config-model.md).
> Read that before adding a config field, a campaign variant, or a persona.
>
> **Meta CAPI for a client** — follow [`docs/capi-setup-sop.md`](docs/capi-setup-sop.md)
> step by step; it carries every Meta-side rejection we've hit and its fix. Don't re-derive
> the setup from `onboarding.md` §7 (config reference only).
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
then hands the turn to `ConversationDO.scheduleTurn()` **inside `ctx.waitUntil`, after answering GHL** (since
2026-08-27: awaiting the DO in the request put its latency on GHL's ~10 s timeout — a stalled
`scheduleTurn` got the request canceled and the turn lost). A failed RPC is retried once before the in-request fallback, and `runAgentTurn` stands down
if an outbound already exists after its inbound (`run_superseded {reason:'already_answered'}`) — the
double-run guard for the one case two schedulers can reach the same message. `scheduleTurn` stores the turn and arms a **durable 15s Alarm**
(each new inbound resets it → debounce/coalescing). On the alarm the DO runs `runAgentTurn`.
Because a DO instance is single-threaded, all processing for a conversation is **serialized**
(kills the double-run / self-block-on-booking class), and the Alarm is **durable** (kills the
silent-drop class). The same alarm also carries the **pause-resume** (0053): a turn suppressed
by the human pause is stored back and the alarm re-armed for the pause expiry, flagged
`resumed` (see `worker/resume-gate.ts`). This is the Durable Objects migration — Phase 1 done; see
[`docs/durable-objects-migration.md`](docs/durable-objects-migration.md).

The old compensating patches were **deleted in Phase 3 (2026-07-03, migration 0030)** once the DO
was proven: the per-minute **reconciliation cron**, the `reconcile_claimed_at` atomic claim
(`claimTurnForProcessing` + its column/RPC). What remains is a **cheap rollback belt**:
`handleInboundWebhook` still has a `waitUntil` **fall-through** used only if the DO call throws, and
the `DO_TURNS` flag can be emptied to fall every tenant back to the legacy `waitUntil` path (no
redeploy). **GHL webhook retries are the last safety net**: a retry of a message we already
stored hits the `ghl_message_id` dedup, and `findUnansweredInbound` decides whether to run the turn
anyway — by whether a `turn_scheduled` event exists at/after the stored message (both paths log it),
**not** by the message's age. The old 60-second minimum dropped the one retry that could have saved
a message whose first request died before scheduling (The Bot Crew, 2026-08-27, retry at +18 s). The DO binding reaches the route via `workerEnvStorage` (AsyncLocalStorage) —
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
  live in Supabase. **`demo_off_keywords[0]` is lead-facing** — the demo start announcement and
  the demo reminders both print it verbatim, so keep an operator shorthand out of that first slot
  and prefer a two-word phrase (`salir demo`): the exit matcher is whole-word and a lead
  roleplaying their own customer will type a bare "salir" by accident. Onboarding a client is a DB row + config — no redeploy for the common case.

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
    core/                      # role interface + registry, tenant resolver, request-context, env (incl. per-tenant AI key resolution), llm-usage (token normalization), prompt-rules (wording bans shared by every role — see business-logic §6c), types
    roles/
      front-desk/              # config (zod), prompt (es template), agent, tools/, evals/
      reactivation/            # text-only follow-up/reactivation agent (no tools)
    ghl/                       # webhook parse/verify, OAuth, tags + transport-only API client (live)
    meta/                      # Meta Conversions API (0048/0056): capi-config (pure parse/payload, per-channel identity, lead_replies_required reply-threshold) + capi (enqueue + Graph send)
    db/                        # service-role Supabase client, queries (config read + RPC writes)
    worker/                    # webhook-handler (inbound) + conversation-do (per-conversation Durable Object: durable-alarm debounce + serialized turn) + outbound-handler (human takeover) + tag-handler (bot-off) + delivery-retry + followup-runner + capi-runner (Meta CAPI queue drain) + info-gap-runner + info-gaps/ (0054: what the bot couldn't answer — extraction queue, aggregate, report; pending_info escalation)
  scripts/simulate-webhook.mjs # local dev: fire a fake GHL webhook
  scripts/demo-take.mjs        # arma/cierra una toma del demo de bótox para grabar video (business-logic §5b)
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
                               # 0033 per_tenant_ai_key_and_llm_usage (ai_key_ref slug + llm_usage/model_pricing + cost view),
                               # 0034 awaiting_human_tag, 0035 reactivation_rules (awaiting_human status + selective reactivation),
                               # 0036 prompt_variants (per-campaign prompts: n:1 keyword→variant, first-touch sticky),
                               # 0037 demo_restamp_fix (idempotent demo activation + demo guards: no real side effects in roleplay),
                               # 0038 demo_sessions (lead-magnet funnel: budgeted per-lead self-demos, startDemo tool,
                               #      role_started_at expand, simulated booking in demo mode — see business-logic §5c),
                               # 0039 tenant_config_history (trigger-based audit: full-row snapshots on every config edit;
                               #      diff/revert per tenant; no code reads it),
                               # 0040 closer_role (a demo ends INTO active_role='closer' — the setter persona persists
                               #      for the whole post-demo conversation, not just the flip turn),
                               # 0041 demo_end_reason_booked (a simulated booking ends the demo: objective met → pitch),
                               # 0042 lead_disqualified_event (optional `reason` on updateConversationStatus →
                               #      a distinct event, so a lead ruled out on purpose stops looking like an
                               #      ordinary standby — see business-logic §2b),
                               # 0043 followup_send_gate_and_demo_reminders (atomic commit gate before a nudge is sent
                               #      + follow_ups.kind: the demo gets its own 3-rung, LLM-free ladder — see business-logic §4/§4.2),
                               # 0044 awaiting_human_is_sticky (app_update_conversation_status now returns boolean and
                               #      REFUSES awaiting_human → standby/completed, the two reactivable states, so the
                               #      lead's next message can't re-arm the cadence; logs status_change_blocked.
                               #      false ⇒ the caller must not mirror the status tag onto the GHL contact.
                               #      **Apply BEFORE deploying**: the old RPC returned void → null → reads as refused),
                               # 0045 opted_out_mutes_the_bot (app_is_bot_suppressed now mutes on opted_out too — the
                               #      farewell still sends, the mute starts at the NEXT inbound — plus the undo:
                               #      removing the `bot-opted-out` tag clears it, one-directionally. See business-logic §2a),
                               # 0046 message_attachments (messages.attachments + app_log_message p_attachments +
                               #      app_set_message_content: voice notes/images were DROPPED at parse — see business-logic §7),
                               # 0047 local_prod_parity (no-op on prod; repairs the schema drift left by the silently
                               #      skipped 0014a–d — see "Migration numbering" below),
                               # 0048 meta_capi (per-tenant Meta Conversions API: tenant_config.meta_capi jsonb,
                               #      conversations.ctwa_clid/attribution captured from the GHL contact, capi_events
                               #      durable queue + RPCs, drained by the 1-min cron — see business-logic §6a.
                               #      Per-tenant secret META_CAPI_TOKEN__<SLUG>, NO platform fallback),
                               # 0049 reactivation_rounds (front-load + taper + stop: conversations.reactivation_round
                               #      + follow_ups.round + tenant_config.follow_up_rounds; a round is consumed when the
                               #      first nudge of a cycle SENDS; past the last round the bot answers but never nudges;
                               #      the farewell teaches "CITA"; a real booking resets the counter; help mode gates all
                               #      nudges while an upcoming appointment exists (GHL-checked — staff-booked appts have
                               #      no store row) — see business-logic §4.3. Folded in 0043's contract step (dropped
                               #      the 3-arg app_schedule_follow_up). PENDING CONTRACT: drop the 4-arg overload in a
                               #      later release once the 0049 deploy is proven),
                               # 0050 pending_info_tag (el bot dejó de pedir permiso: cuando le preguntan algo que la
                               #      config no tiene, AFIRMA que lo confirma con el equipo y llama flagPendingInfo →
                               #      status awaiting_human + tenant_config.pending_info_tag + evento pending_info con
                               #      la pregunta TEXTUAL. Tag SEPARADO de awaiting_human_tag a propósito: esa cola es
                               #      del cliente (agendar), ésta es de quien opera la plataforma (a la config le falta
                               #      un dato). El tag handler trata ambos como UNA señal (OR): quitar sólo el de
                               #      agenda deja los nudges apagados si el dato sigue pendiente — ver business-logic §6b),
                               # 0051 marketing_opt_out (conversations.marketing_opted_out_at + el RPC
                               #      app_set_marketing_opt_out_by_contact: el tag `marketing-opt-out` de GHL estampa la
                               #      fecha y ya. NO es `bot-opted-out`/0045 — eso es consentimiento de la conversación y
                               #      calla al bot; esto es de las campañas de GHL, que no manda el bot. Nada en el Worker
                               #      lee la columna: es registro histórico. Write-once por el `IS NULL` del RPC, así que
                               #      quitar el tag NO borra la fecha y volver a darse de baja conserva la original),
                               # 0052 human_pause_minutes (pausa de takeover humano por tenant: NULL = 5 min;
                               #      MADI = 30 — su equipo trabaja los hilos más de 5 min y el bot re-entraba),
                               # 0053 resume_after_human_pause (evento `resume_skipped`: un turno suprimido por la
                               #      pausa ya no se pierde — el DO re-arma la alarma al vencer y re-corre el turno
                               #      por el resume gate; cada silencio queda con su motivo),
                               # 0054 info_gaps (lo que el bot no supo contestar, por tenant: cola de extracción
                               #      `info_gap_extractions` drenada 5/tick por el cron de 5 min, acumulado por tema en
                               #      `info_gaps`, reporte markdown en `info_gap_reports` servido por
                               #      GET /reports/info-gaps/:tenantId?key=<tenant_config.report_key>; cadencia en
                               #      tenant_config.info_gaps. Aparte, la escalación diaria (cron `0 13 * * *`): un
                               #      pending_info sin respuesta humana en N horas recibe un TERCER tag
                               #      (`pending_info_escalation_tag`). Nada escribe tenant_config — ver business-logic §8),
                               # 0055 report_key (llave del reporte POR TENANT en tenant_config.report_key, generada por la
                               #      DB: sin secret de Worker, una URL por cliente, rotar = UPDATE),
                               # 0056 capi_messaging_channels (CAPI en Messenger e Instagram: conversations.capi_match_key =
                               #      la llave de matching del canal — ctwa_clid en WhatsApp, PSID en Facebook, IGSID en
                               #      Instagram — todas expuestas por GHL en contact.attributionSource; ctwa_clid sigue
                               #      dual-write hasta el contract. El messaging_channel viaja congelado en el payload de la
                               #      cola, sin cambio de RPC. meta_capi gana whatsapp_business_account_id /
                               #      instagram_business_account_id (IG lo REQUIERE) — ver business-logic §6a),
                               # 0057 lead_timezone (la zona horaria DEL LEAD para tenants de servicio remoto:
                               #      conversations.lead_timezone + _source ('phone' = adivinada por LADA, sólo rellena;
                               #      'lead' = la dijo el lead, siempre gana — la precedencia vive en el RPC
                               #      app_set_lead_timezone), tenant_config.lead_timezone_enabled DEFAULT false — un
                               #      negocio presencial con el flag prendido ofrece horas corridas. Los labels salen en
                               #      la hora del lead con sufijo "hora de …" sólo cuando el offset difiere; el modelo
                               #      nunca convierte. Ver business-logic §5d),
                               # 0058 interest_tags (tenant_config.interest_tags DEFAULT false: el clasificador de status
                               #      —la misma llamada aux— devuelve además `interest` = UN nombre de services[].name, validado
                               #      en core/interest.ts, y el contacto recibe el tag `interes-<slug>` + evento interest_tagged.
                               #      Con el flag, el clasificador corre en CADA turno contestado; sin él, byte-idéntico a antes.
                               #      Ver business-logic §9)
  clients.sql, seed-tenants.sql# seeds (run by `supabase db reset` per config.toml)
sites/                         # client marketing sites: static HTML, no build step, no deps
  _template/                   # starting point for a new client
  madi-skincare/               # first client — reference for how far to push identity, not a mold
```

**Migration numbering — NEVER use a letter suffix.** Files must be `NNNN_name.sql` with a
**purely numeric** prefix. The CLI parses the version as digits only: a letter-suffixed file
(`0014a_…`) does not match and is **SKIPPED SILENTLY** — it prints nothing, records nothing,
and `db reset` still says "Finished". `0014a`–`0014d` were never applied to any local DB;
only prod had them (applied by hand, backfilled into the repo afterwards). That went unnoticed
until 2026-08-01, when a local test failed on a `facebook` channel constraint prod does not
have — meaning **every local dry-run since 2026-07-28 had been validating against a schema
that silently differed from prod**, which is the one thing dry-runs exist to prevent.
Migration 0047 repaired the drift (it is a no-op on prod); the audit found only two objects
had actually diverged, everything else having been overwritten by later migrations.

To insert between numbers, **renumber to the end** instead — order only matters where
statements depend on each other, and renaming is safe for prod (prod's ledger uses timestamp
versions like `20260613171711`, not these filenames). Two files sharing a prefix break
`supabase start` / `db reset` outright (duplicate key on `schema_migrations_pkey`), which is
the loud failure; the silent skip above is the dangerous one. **`ls supabase/migrations/ | tail`
before naming a new file** — the highest number in the docs is not always the highest on disk
(0043 was almost written as a second 0042).

**Verify a migration landed, don't assume.** After `db reset`, confirm the file appears in the
"Applying migration …" output, and for anything schema-shaped compare local against prod
directly (`pg_get_constraintdef` / `pg_get_functiondef`, comment-stripped for function bodies)
rather than trusting that the file ran. Also: the Bash tool's cwd persists between calls — a
`cd /tmp` earlier in a session makes `supabase db reset` fail with "supabase start is not
running" while a piped `grep | head` still exits 0, so the failure looks like success.

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
  Run it **serially** (`pnpm --filter @thebotcrew/workers exec vitest run --fileParallelism=false`)
  — the whole suite in parallel exceeds OpenAI's 200k tokens/min and fails as rate limits that
  look exactly like assertion failures.
- **The eval fixtures MIRROR prod, and that copy must be kept in sync.** A tenant's real
  behavior is DB text (`tenant_config.prompt_overrides`), which evals can't read at test time,
  so `roles/front-desk/evals/fixtures.ts` carries a **hand-typed copy** of the rules under test
  (`FIT_FILTER_SECTION`, `MONEY_DISCLOSURE_RULES`, `CALL_OFFER_RULE`, `MADI_HOUSE_RULES`, and
  `DEMO_BOTOX_PERSONA` — the botox demo persona, mirrored WHOLE from `demo_prompt_overrides`
  rather than by section, since the persona is small and entirely under test). Edit a tenant row in
  Supabase without updating it and every golden case keeps passing against text nobody runs —
  green tests that prove nothing. **So: whenever you change a tenant's prompt, update the
  fixture in the same change, by pasting the live text back, verbatim** (no reflowing, no
  "small" wording fixes). `prompt-drift.eval.ts` is the alarm: the only case that talks to the
  DB, it asserts prod still CONTAINS each mirrored section byte-for-byte and self-skips without
  Supabase env vars. When it fails, decide which side is right — usually prod is (Leo edits the
  tenant) and the fixture must be re-copied.
- **A new golden case must be shown FAILING before it is trusted.** Delete the rule it defends
  from the fixture and confirm the case goes red; a case that passes either way tests nothing.
  Model behavior is a rate, not a switch, so measure 3–5 runs on both sides and write the
  numbers in the file's header — and reproduce an incident on the model that produced it
  (`EVAL_MODEL=gpt-5-mini pnpm eval`), not on the one we just moved to. See business-logic §6c.
- **`pnpm test:db`** — the layer the mocks can't reach. Several invariants live **inside the
  RPCs** (follow-up gating on `status='active'`, the 0043 send gate, the 0044 `awaiting_human`
  guard), and `test:unit` mocks `db/queries` wholesale, so it proves only what the Worker does
  with the RPC's answer — never the answer itself. Each file in `supabase/tests/*.test.sql` runs
  in a transaction and rolls back, so it's repeatable against the local stack without a reset.
  Needs `supabase start`; **not** in CI (no DB there).
- Run `pnpm test:unit` before any change to orchestration/parsing, `pnpm test:db` after touching
  a migration or an `app_*` RPC, and `pnpm eval` before a change to a role's prompt or tools.
  `worker/info-gaps/extract.eval.ts` is the one live eval outside a role: the info-gap extractor
  on a real MADI thread, old config vs new config (the `already_in_config` verdict).
  (Layer 3 golden-conversation gate on staging: TBD.)

### Deploy
- `pnpm typecheck` + `pnpm test:unit` (the gate) then `pnpm build` (mastra build via
  CloudflareDeployer) → `pnpm --filter @thebotcrew/workers exec wrangler deploy`. Set Worker
  secrets with `wrangler secret put <NAME>` (see `.env.example`). Staging step TBD.
  `GET /reports/info-gaps/:tenantId?key=…` (HTML; `&format=md` for markdown) is gated by the
  tenant's own `tenant_config.report_key` (0055, DB-generated) — no Worker secret involved.
- **Gradual rollout (preferred now that a client is live):** `wrangler versions upload` →
  `wrangler versions deploy` at a percentage → ramp → `wrangler rollback` if needed. Caveat:
  a deploy that includes new **Durable Object migrations** cannot roll out gradually.
- **Migrations are expand/contract, as a hard rule:** the CF deploy and the Supabase migration
  are not atomic, so every migration must be backward-compatible with the currently deployed
  Worker (add nullable columns/tables → deploy code → drop/rename in a LATER release).
  Example in flight: `role_started_at` (0038) supersedes `demo_started_at`; both are written —
  drop the old column only after the deploy is proven.

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
  **The wall-clock frame is the LEAD's zone for tenants with `lead_timezone_enabled`** (0057,
  `core/lead-timezone.ts` + `tools/slot-label.ts`): every label the tools hand the model is
  rendered in the clock the lead reads, suffixed "hora de …" when it differs from the calendar's,
  and matched back in that same frame. The zone is guessed from the phone's area code (fills
  only) or stated by the lead (`setLeadTimezone` tool, wins). Off by default — right for a
  video call, wrong for a walk-in clinic. **The zone is also mirrored onto the GHL contact's
  Timezone field** (`ghl/contact-timezone.ts`, when learned + right before every
  book/reschedule): GHL's own confirmation/reminder workflows render `{{appointment.start_time}}`
  in that field, and the booking API carries no timezone — it's the only lever. See
  docs/business-logic.md §5d.
- Name at booking (2026-08-29): the booking sequence asks "¿A nombre de quién agendo la cita?" only
  when the lead hasn't said their name in the conversation (the CRM name doesn't count — IG/FB
  leads arrive as their handle), and passes it as `contactName` to `bookAppointment`, which writes
  the contact **before** the booking POST (GHL greets `{{contact.first_name}}` in the confirmation).
  `core/contact-name.ts` is the one first/last split. Platform-wide; see docs/business-logic.md §5.
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
- Human takeover (hybrid): a human reply (`source:'app'` outbound webhook) opens a
  sliding pause — per-tenant length via `tenant_config.human_pause_minutes` (0052),
  NULL = 5 min default (MADI: 30); `status='handed_off'` is a permanent pause. A lead
  message that arrives DURING the pause is not dropped (0053): the DO re-arms its alarm
  for the pause expiry and re-runs the turn through the **resume gate**
  (`worker/resume-gate.ts`: skip if someone already answered, skip if the last message is
  a courtesy close — a cheap classifier biased to reply). A human's message reaches the model
  **marked** (`core/model-messages.ts`, `[Respuesta de una persona del equipo]`) and the prompt
  treats it as the official answer — unmarked, the model read it as its own words and kept
  "confirming with the team" what the team had confirmed. See docs/business-logic.md §3. Both are enforced by
  `isBotSuppressed`, re-checked again right before send (anti-double-message). **Exception:** a
  `source:'app'` message that is the conversation's FIRST message is a cold-outreach opener (e.g.
  a WhatsApp template on a new contact) — logged but no pause, so the bot answers the lead's reply.
- Tag kill switch: the `bot-off` tag on a GHL contact = permanent handoff; removing it
  resumes the bot (no `bot-on` tag — absence means on). Wired via the **ContactTagUpdate**
  webhook → `/webhooks/ghl/tags` → `worker/tag-handler.ts` (contact-scoped: resolves by
  `ghl_contact_id`). The bot also writes tags when IT sets a status (`ghl/tags.ts`
  `STATUS_TAGS`), so state stays visible/synced in GHL. **Requires the `contacts.write`
  scope** (`ghl/oauth.ts`) — adding it means tenants must re-authorize the Marketplace app.
- Escalation tag (0054) — the **third** tag, and it is not a queue: `pending_info_escalation_tag`
  (e.g. `dato-sin-respuesta`) is ADDED by the daily cron when a `pending_info` got no human reply
  within `pending_info_escalation_hours` (NULL = 24). The tag handler ignores it; it exists so the
  aged-out question shows up in the team's inbox. Idempotent via `pending_info_escalated`. §8.
- Owed-answer tags — **two queues, one state**: `awaiting_human_tag` (e.g. `esperando-agenda`,
  0034: the CLIENT owes a booking) and `pending_info_tag` (e.g. `dato-pendiente`, 0050: WE owe a
  fact the config lacks, written by `flagPendingInfo`). Different owners, so they must be
  different tags — but both mean "don't nudge her", so `tag-handler.ts` ORs them: she leaves
  `awaiting_human` only when **both** are gone. Clearing just the booking tag deliberately keeps
  the nudges off while a data point is still pending. See docs/business-logic.md §6b.
- Opt-out undo (0045): `opted_out` now mutes the bot like `handed_off`, and since a classifier
  (an LLM) sets it, **removing the `bot-opted-out` tag clears it** — same route/handler. Adding
  the tag opts nobody out; the switch only undoes. See docs/business-logic.md §2a.
- Interest tags (0058): `interes-<servicio>` per configured service the lead asks about, chosen by the
  status classifier (not the agent, not a keyword match), validated against `services[].name`
  (`core/interest.ts`), opt-in per tenant via `tenant_config.interest_tags`. Never removed. See
  docs/business-logic.md §9.
- Cancelled-appointment tag (2026-08-28): `cita-cancelada` is ADDED by `cancelAppointment` and by the
  staff workflow's `cancelled` action, REMOVED by any new booking (both paths). Platform constant
  (`ghl/tags.ts`), no config, no LLM, skipped in demo. A smart-list hook for GHL reactivation
  campaigns — it does not change what the bot does after a cancel (still `standby`, no nudges).
  The cancel prompt rule now offers to reschedule first; see docs/business-logic.md §5.
- Marketing opt-out (0051) — a date, not a switch. The `marketing-opt-out` tag stamps
  `conversations.marketing_opted_out_at` and changes nothing else: it is consent about the GHL
  **campaigns**, which the bot neither sends nor reads. Do not confuse it with `bot-opted-out`
  above (consent about the conversation, and it mutes). **Write-once** — removing the tag does
  NOT clear the date, because whether they're opted out *now* is already live on the tag in GHL;
  the date is the only thing the column adds. Scope: it only reaches contacts that have a
  conversation row, and a row created after the opt-out is born NULL, so query "does this contact
  have ANY row with a date". Covering contacts the bot never spoke to needs a real `contacts` table.
- Webhook routes (configure in the Marketplace app): InboundMessage → `/webhooks/ghl`,
  OutboundMessage → `/webhooks/ghl/outbound`, ContactTagUpdate → `/webhooks/ghl/tags`.
- Staff-booked appointments → `/webhooks/ghl/appointments` (NOT a Marketplace event: a
  per-tenant GHL **workflow** "Customer Booked Appointment" → Webhook action posting its
  DEFAULT payload — parser reads `location.id`, root `contact_id` (phone/email search
  fallback), `calendar.appointmentId`, optional custom-data `action`; auth =
  `Bearer GHL_WORKFLOW_SECRET` Worker secret, fails closed while unset). Only IDs are
  trusted — startTime/title are fetched live from GHL (`calendar.startTime` is offset-less
  wall-clock, the 5:15→10:15 bug class). Dedups by appointment id+action (the workflow
  fires for bot bookings too), logs `source='ghl-workflow'`, and on `booked` cancels
  pending nudges + resets `reactivation_round` (parity with a bot booking, 0049).
  Setup per tenant: [`docs/onboarding.md` §8](docs/onboarding.md).
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
  - `keyword_variants` + `prompt_variants` (jsonb, 0036) — **per-campaign prompts**: keyword →
    variant key (n:1, longest match wins), variant key → partial overrides merged field-by-field
    over `prompt_overrides`. First-touch sticky per conversation (`conversations.prompt_variant`,
    `app_set_prompt_variant`); orthogonal to the gate; demo persona wins over the variant.
    **The merge is a spread, so a variant replaces a whole FIELD** — a tenant-wide rule
    written inside `qualificationNotes` silently disappears for that campaign's leads: no
    event, no failure, it just stops happening. Hence **`houseRules`**: a base-only override
    field (not in `promptVariantSchema`) rendered after the flow and labelled as outranking
    it, suppressed in demo mode. Tenant-wide rules go there, never in `qualificationNotes` —
    that's where the fit filter (§2b) lives. A variant changes the script, not the toolbox —
    every tool stays callable. See docs/business-logic.md §1.1.
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
- Platform default: `openai` / `gpt-5.6-luna` (2026-08-11; before that `gpt-5-mini`, itself
  raised from `gpt-4o-mini` — the older mini contradicted its own availability slot list; see
  `bot_events.availability_checked`). Per-tenant override stored in `tenant_config.ai_provider`
  + `tenant_config.ai_model`; **no tenant overrides today** — all four inherit the default.
- Both `@ai-sdk/openai` and `@ai-sdk/anthropic` are installed. The agent creates the right
  provider at request time from the key in the request context.
- **Reasoning effort** (`core/reasoning.ts`). The OpenAI provider function resolves to the
  **Responses API** (`createOpenAI(...)(modelId)` → responses model), so effort rides along as
  `providerOptions: { openai: { reasoningEffort } }`. Set per role on the agent's
  `defaultOptions`, which Mastra deep-merges into every `generate()` — so **evals run at the
  same effort as production**, which is the whole reason it isn't set at the call site:
  - front-desk `high` (it picks the tool and decides what may not be said),
  - reactivation `low` (a one-line nudge, paid per silent lead by the cron),
  - the two auxiliary Chat Completions calls `none` (see below).
  `tenant_config.ai_model` may name any model, so the effort is only sent where the model
  takes it — outside the gpt-5 family the parameter is a 400, and on a fire-and-forget aux
  call a 400 dies silently. `none` needs a minor version (flat `gpt-5` rejects it), which is
  why `auxReasoningEffort` returns `undefined` rather than falling back to `minimal` —
  `minimal` still runs a reasoning pass, and that pass is what eats `AUX_MAX_COMPLETION_TOKENS`.
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
    inventing one. Loaded so far: `gpt-5-mini` @ $0.25 / $0.025 cached / $2.00 output;
    `gpt-5.6-luna` @ $0.20 / $0.02 cached / $1.20 output (from 2026-08-11). Reasoning
    tokens bill as **output**, so a raised effort lands on the output side of this view.
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
