# TODO

## v0 Hardening (P0 — before onboarding more clients)
> Strategic review + per-item plans in `docs/production-readiness-and-roadmap.md`.
> Suggested order: testing harness first (unblocks the others) → webhook auth → durable execution.
- [ ] **Testing harness & deploy gate** — see `docs/plan-testing-strategy.md`. Layer 2 orchestration tests (mock `db/queries.js`) first; then Layer 1 pure-function tests (webhook parse/verify, FAQ matcher, classifier gate); then Layer 3 golden-conversation regression set. Split `test:unit` (always) from `eval` (API-key gated); CI blocks merge on Layers 1–2.
- [x] **Webhook authentication** — `verifyGhlWebhook()` verifies the RAW body in each route handler before parse: **Ed25519** (`x-ghl-signature`, current) + **RSA-SHA256** (`x-wh-signature`, legacy → 2026-07-01) fallback, against GHL's published public keys (embedded). Fails closed → 401. All 3 routes (`/webhooks/ghl`, `/webhooks/ghl/outbound`, `/webhooks/ghl/tags`). Dev bypass `ALLOW_UNVERIFIED_WEBHOOKS`. Validated: reject path 401, accept path confirmed with a real GHL webhook
- [ ] **Durable turn processing** — see `docs/plan-durable-execution.md`. The 8s debounce is a `setTimeout` in `waitUntil` and a model/GHL failure silently drops the turn (no retry). Migrate `runAgentTurn` onto Cloudflare Queues + `delaySeconds` (retries + DLQ); keep the `isLatestInboundMessage` gate for burst coalescing. **First: timebox a spike** on how `CloudflareDeployer` exposes queue bindings (the main risk). Add idempotency guards (no double-send under retry). Fallback if the spike stalls: a reconciliation cron that re-runs any inbound with no reply after ~30–60s.

## Infra / Deploy
- [ ] Add a custom domain to the Worker (replace `workers.dev` URL) — add `"routes"` to `wrangler.jsonc` and redeploy
- [ ] Set up a staging environment (separate Worker name + secrets)

## GHL Integration
- [x] Confirm outbound message endpoint (`POST /conversations/messages`) + auth header → wire `GhlClient.sendMessage()`
- [x] Confirm inbound webhook payload field names — `type=InboundMessage`, `direction=inbound`, `locationId/contactId/conversationId/body/messageType` all confirmed
- [x] Resolve auth model: per-location OAuth via GHL App Marketplace → `ghl_oauth_tokens` table, install at `/oauth/ghl/install`
- [x] Webhook signature scheme confirmed + implemented — Ed25519 (`x-ghl-signature`) + RSA legacy (`x-wh-signature`); see Webhook authentication above
- [x] Handle outbound GHL webhook events — `outbound-handler.ts` stores human-agent messages (`source:'app'`) so history stays complete on takeover
- [x] Wire contact tags (`GhlClient.addContactTags` / `removeContactTags`, `contacts.write` scope, Version `2021-07-28`) — used by the handoff tag sync
- [~] Wire calendar availability (`GhlClient.getAvailability()`) — implemented; not yet live-tested against a real GHL calendar
- [~] Wire appointment booking (`GhlClient.bookAppointment()`) — implemented; not yet live-tested against a real GHL calendar

## Agent / Roles
- [x] Seed real tenant config — The Bot Crew (`wRMDr6h3anwYpM64XAUe`): services, hours, calendars, FAQ, provider/model
- [x] Provider-agnostic model layer — OpenAI/Anthropic switchable per tenant via `tenant_config.ai_provider` + `ai_model`; default `openai/gpt-4o-mini`
- [x] Message debounce — 8s wait after last inbound message before agent runs; gate via `last_inbound_message_id` to prevent duplicate replies on burst messages
- [x] Conversation status lifecycle — `active / handed_off / completed / opted_out / standby`; `updateConversationStatus` tool for front-desk agent
- [x] Follow-up / reactivation system — configurable tiers per tenant (`follow_up_tiers` jsonb); reactivation agent (text-only); cron every minute processes due follow-ups; cancels on inbound; schedules after every bot reply; standby after last tier
- [x] The Bot Crew prompt tuned — setter flow with drip-fed taller info per step, examples per paso, no "Sí/No" labels, keyword "AGENTE" detection
- [ ] Run evals (`pnpm eval`) and review results against real tenant config
- [ ] Add anti-hallucination eval cases
- [ ] Review reactivation message quality from live sessions and tune angles per tier
- [x] `updateConversationStatus` in front-desk prompt — agent instructed when to call it; two-stage classification fallback (`classifyConversationOutcome` via raw OpenAI fetch) runs after every bot reply with no `?` as reliable backstop
- [ ] GHL pipeline sync — trigger GHL contact tag/stage updates based on conversation *outcomes* (disqualified, opted_out, registered), not on internal status changes; the two are separate dimensions: status tracks bot behavior, GHL pipeline tracks sales state. Needs: (a) an outcome event emitted by the agent/classifier, (b) per-tenant config mapping outcome → GHL tag or pipeline stage, (c) a GhlClient method to apply them

## Human Takeover
- [ ] **Distinguir mensajes humanos en el historial del modelo:** actualmente los mensajes de agentes humanos se pasan al LLM como `role: "assistant"`, igual que los del bot. El modelo no sabe que fue un humano quien habló. Mejora futura: prefixar con `[Agente: ...]` o inyectar una nota en el system prompt para que el bot sepa dónde retomó el humano y dónde continúa él.


- [x] Outbound webhook endpoint (`POST /webhooks/ghl/outbound`) — logs human-agent messages, sets 5-min sliding timer (`human_active_until`), cancels follow-ups
- [x] `app_is_bot_suppressed` — composite check: `handed_off` (manual) OR `human_active_until > now()`
- [x] `isBotMessageById` secondary guard — identifies GHL echo of bot's own message (GHL sends `source: "app"` even for API-sent messages when OAuth token is tied to a user)
- [x] Store `ghl_message_id` on bot outbound messages after send — required for echo detection to work
- [x] **Tag-based handoff (`bot-off` kill switch)** — `ContactTagUpdate` webhook → `/webhooks/ghl/tags` → `tag-handler.ts`; `bot-off` tag ↔ `handed_off` (contact-scoped via `app_set_bot_off_by_contact`). The bot also writes `bot-off`/status tags on the contact when it sets a status (`ghl/tags.ts` `STATUS_TAGS`). Needs `contacts.write` scope. Validated end-to-end against live GHL webhooks
- [x] **Anti-double-message guard** — re-check `isHumanActive` right before send (before logging the outbound, so the retry cron can't re-send a dropped reply); the agent's own self-handoff farewell still goes out
- [ ] **Follow-up gap after human takeover:** when human agent responds and timer expires, no follow-up is scheduled. If lead goes silent after human responds, bot stays passive indefinitely. Decision needed: (A) don't cancel follow-ups on human takeover (timer already suppresses bot), or (B) re-schedule a follow-up when `human_active_until` expires and lead hasn't replied
- [ ] Confirm two-webhook behavior (sent + delivered) for real human messages — dedup by `ghl_message_id` should handle it, verify in production

## Per-tenant reply gating (`tenant_config`, enforced in `webhook-handler.ts`)
> Inbound is always stored; only the *reply* is gated. Gate order: channel/test → keyword.
- [x] **Channel control** (`enabled_channels text[]`) — NULL = silent (onboarding default); existing tenants backfilled to all three. `channelEnabled` helper. Validated (HappyNatyNat replies on FB, gates WhatsApp)
- [x] **Pre-live test mode** (`test_contact_ids text[]`) — when non-empty, reply only to those contacts on any channel (bypasses channel gate). `inTestMode` helper
- [x] **Trigger-keyword entry gate** (`trigger_keywords text[]` + `conversations.bot_activated`) — bot only ENTERS when a message contains a keyword (whole-word, accent-insensitive); once activated the thread flows. `messageMatchesTrigger` + atomic `app_bot_activation`. Validated
- [ ] Expose these gates in a future dashboard/onboarding UI (today they're set via SQL)

## Follow-up System
- [x] Migration 0012 — `follow_ups` table + 7 RPCs (`app_cancel_follow_ups`, `app_schedule_follow_up`, `app_load_due_follow_ups`, `app_mark_follow_up_sent`, `app_mark_follow_up_failed`, `app_update_conversation_status`, `app_reactivate_conversation`)
- [x] Reactivation agent — text-only, no tools, angle threaded via request context
- [x] Cron triggers — `* * * * *` (follow-ups) + `*/5 * * * *` (delivery retries); scheduled handler imports directly from `#mastra` (self-fetch pattern unreliable in CF scheduled context)
- [x] The Bot Crew tiers configured — 15 min / 3 h / 6 h / 12 h with distinct angles
- [ ] Tune reactivation angles per tier based on real response data
- [x] Atomic follow-up claiming — `app_load_due_follow_ups` now atomically sets `status='processing'` with `FOR UPDATE SKIP LOCKED`; prevents duplicate sends when cron invocations overlap via `waitUntil`

## Onboarding
- [x] Seed first real tenant into remote Supabase (`tenants` + `tenant_config` rows)
- [x] **Second tenant — HappyNatyNat** (image consulting / colorimetría, location `X8zdJcQaVckHuF3W4grr`): config + FAQ scraped from site, single "Llamada de diagnóstico" calendar, OAuth installed (incl. `contacts.write`), live on **FB only** (`enabled_channels={facebook}`). Validated end-to-end on Facebook
- [x] Point tenant's GHL subaccount webhook at the Worker URL
- [x] End-to-end live test confirmed working — WhatsApp → Worker → GPT-4o-mini → GHL reply
- [x] Follow-up system live tested — tier 1 sent, tier 2 auto-scheduled, cancel-on-reply confirmed

## Next Steps
- [ ] Observe live follow-up sends and check message quality; tune reactivation angles if needed
- [x] `updateConversationStatus` usage instructions added to front-desk system prompt
- [ ] Monitor The Bot Crew setter flow with real leads — review conversation logs and tune paso transitions as needed
- [ ] Handle the case where a lead reactivates mid-follow-up sequence: currently `reactivateConversation` + `cancelFollowUps` run on inbound, but the front-desk needs to pick up the thread gracefully (history will be there, verify it does)
- [x] `handed_off` webhook handling — `outbound-handler.ts` stores human replies in `messages`; `isBotSuppressed` (handed_off OR human-active timer) stops the AI re-engaging; `bot-off` tag gives humans a manual permanent kill switch
