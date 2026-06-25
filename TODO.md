# TODO

## v0 Hardening (P0 — before onboarding more clients)
> Strategic review + per-item plans in `docs/production-readiness-and-roadmap.md`.
> Suggested order: testing harness first (unblocks the others) → webhook auth → durable execution.
- [ ] **Testing harness & deploy gate** — see `docs/plan-testing-strategy.md`. Layer 2 orchestration tests (mock `db/queries.js`) first; then Layer 1 pure-function tests (webhook parse/verify, FAQ matcher, classifier gate); then Layer 3 golden-conversation regression set. Split `test:unit` (always) from `eval` (API-key gated); CI blocks merge on Layers 1–2.
- [ ] **Webhook authentication** — see `docs/plan-webhook-authentication.md`. `verifyWebhook()` currently accepts any request with *any* signature header (`ghl/webhook.ts:27-32`) — effectively unauthenticated. Implement real RSA public-key verification (`x-wh-signature`) over the **raw body before JSON parse**; move verification into the route handlers; fail closed; protect both `/webhooks/ghl` and `/webhooks/ghl/outbound`. Confirm scheme against GHL docs.
- [ ] **Durable turn processing** — see `docs/plan-durable-execution.md`. The 8s debounce is a `setTimeout` in `waitUntil` and a model/GHL failure silently drops the turn (no retry). Migrate `runAgentTurn` onto Cloudflare Queues + `delaySeconds` (retries + DLQ); keep the `isLatestInboundMessage` gate for burst coalescing. **First: timebox a spike** on how `CloudflareDeployer` exposes queue bindings (the main risk). Add idempotency guards (no double-send under retry). Fallback if the spike stalls: a reconciliation cron that re-runs any inbound with no reply after ~30–60s.

## Infra / Deploy
- [ ] Add a custom domain to the Worker (replace `workers.dev` URL) — add `"routes"` to `wrangler.jsonc` and redeploy
- [ ] Set up a staging environment (separate Worker name + secrets)

## GHL Integration
- [x] Confirm outbound message endpoint (`POST /conversations/messages`) + auth header → wire `GhlClient.sendMessage()`
- [x] Confirm inbound webhook payload field names — `type=InboundMessage`, `direction=inbound`, `locationId/contactId/conversationId/body/messageType` all confirmed
- [x] Resolve auth model: per-location OAuth via GHL App Marketplace → `ghl_oauth_tokens` table, install at `/oauth/ghl/install`
- [ ] Confirm webhook signature scheme (`x-wh-signature` or `x-ghl-signature`, HMAC vs RSA) → replace placeholder in `verifyWebhook()`
- [ ] Handle outbound GHL webhook events — store human-agent messages in our `messages` table so history stays complete when a human takes over a thread
- [ ] Wire calendar availability (`GhlClient.getAvailability()`)
- [ ] Wire appointment booking (`GhlClient.bookAppointment()`)

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
- [ ] **Follow-up gap after human takeover:** when human agent responds and timer expires, no follow-up is scheduled. If lead goes silent after human responds, bot stays passive indefinitely. Decision needed: (A) don't cancel follow-ups on human takeover (timer already suppresses bot), or (B) re-schedule a follow-up when `human_active_until` expires and lead hasn't replied
- [ ] Confirm two-webhook behavior (sent + delivered) for real human messages — dedup by `ghl_message_id` should handle it, verify in production

## Follow-up System
- [x] Migration 0012 — `follow_ups` table + 7 RPCs (`app_cancel_follow_ups`, `app_schedule_follow_up`, `app_load_due_follow_ups`, `app_mark_follow_up_sent`, `app_mark_follow_up_failed`, `app_update_conversation_status`, `app_reactivate_conversation`)
- [x] Reactivation agent — text-only, no tools, angle threaded via request context
- [x] Cron triggers — `* * * * *` (follow-ups) + `*/5 * * * *` (delivery retries); scheduled handler imports directly from `#mastra` (self-fetch pattern unreliable in CF scheduled context)
- [x] The Bot Crew tiers configured — 15 min / 3 h / 6 h / 12 h with distinct angles
- [ ] Tune reactivation angles per tier based on real response data
- [x] Atomic follow-up claiming — `app_load_due_follow_ups` now atomically sets `status='processing'` with `FOR UPDATE SKIP LOCKED`; prevents duplicate sends when cron invocations overlap via `waitUntil`

## Onboarding
- [x] Seed first real tenant into remote Supabase (`tenants` + `tenant_config` rows)
- [x] Point tenant's GHL subaccount webhook at the Worker URL
- [x] End-to-end live test confirmed working — WhatsApp → Worker → GPT-4o-mini → GHL reply
- [x] Follow-up system live tested — tier 1 sent, tier 2 auto-scheduled, cancel-on-reply confirmed

## Next Steps
- [ ] Observe live follow-up sends and check message quality; tune reactivation angles if needed
- [x] `updateConversationStatus` usage instructions added to front-desk system prompt
- [ ] Monitor The Bot Crew setter flow with real leads — review conversation logs and tune paso transitions as needed
- [ ] Handle the case where a lead reactivates mid-follow-up sequence: currently `reactivateConversation` + `cancelFollowUps` run on inbound, but the front-desk needs to pick up the thread gracefully (history will be there, verify it does)
- [ ] Think about adding a `handed_off` webhook event handler so human replies get stored in `messages` and AI doesn't re-engage after handoff
