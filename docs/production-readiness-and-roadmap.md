# Production Readiness & Product Roadmap — Strategic Review

> Audience: Leo + the AI agents implementing this. This is an opinionated, all-dimensions review
> of the platform as it stands today, the weak links most likely to cause real-world failures, and
> a roadmap toward a production-grade, agent-driven, mostly-one-person business. Analysis only — no
> code changed producing it. Findings are tagged **P0** (fix before scaling clients), **P1** (next),
> **P2** (strategic / later). File references point at the exact weak spots.

---

## TL;DR — the five things that matter most

1. **P0 · The webhook is not actually authenticated.** `verifyWebhook()` only checks that a
   signature header *exists* — anyone who knows the URL can inject messages, drive LLM spend, and
   spam your clients' leads. This is the single most urgent fix.
2. **P0 · Turn processing is not durable.** The 8s debounce is a `setTimeout` inside
   `waitUntil`; a model outage or isolate eviction silently drops the reply with no retry. The
   reliability story needs durable execution (Durable Objects / Queues), not hand-rolled timers.
3. **P0 · The core booking action is still stubbed.** `bookAppointment()` returns a fake id. The
   headline value ("books appointments") isn't real yet.
4. **P1 · There is no observability or QA layer.** No trace storage, no per-conversation review,
   no metrics. You cannot see, monitor, or improve what you can't measure — and the whole
   "one-person business" vision depends on AI watching the AI.
5. **P2 · The biggest growth lever is AI-assisted onboarding.** Turning "configure a tenant" from
   hours of manual JSON into minutes (ingest a website + intake → generate `tenant_config`) is
   what makes one person able to run hundreds of clients.

---

## Part 1 — Is the architecture correct?

**Largely yes, for this stage.** The foundational calls are right and worth protecting:

- **One Worker, per-request tenant context** (`runtime-context.ts`, `agent.ts` dynamic
  instructions/model) — the idiomatic, scalable multi-tenant pattern. Good.
- **Code = product, DB = per-tenant variables** — the right boundary; keep enforcing it.
- **We own conversation history with sender attribution** (`messages` + RPC writes) — this is the
  strategic moat (human↔AI collaboration, analytics, training data). Do not regress to reading
  history from GHL.
- **Role abstraction** (front-desk, reactivation) with a uniform interface — extensible.
- **OAuth per-tenant with auto-refresh** (`ghl/client.ts`) — correct auth model.
- **Defensive parsing, dedup (0008), atomic follow-up claiming (0014), delivery retry, human
  takeover with suppression** — these show real production instincts already.

### The one architectural evolution to plan now: durable execution

Today the runtime hand-rolls scheduling on three mechanisms: `setTimeout`-in-`waitUntil`
(debounce), a 1-minute cron polling the DB (follow-ups + delivery retries), and inline retries.
This works at low volume but has structural cracks (see Part 2). The right next-generation shape
on Cloudflare:

- **A Durable Object per conversation.** Gives you: a durable debounce (alarms survive eviction),
  strictly ordered per-conversation processing (no two turns racing — today this is patched with
  the `last_inbound_message_id` gate), a natural home for per-conversation locking/state, and
  back-pressure isolation so one hot conversation can't starve others.
- **A Queue (with retries + DLQ) for the heavy tail** — model generation, GHL sends, follow-ups.
  The webhook's only job becomes: verify → persist inbound → enqueue → return 200. Processing
  becomes independently retryable and observable, and a model/GHL outage degrades into a retry
  instead of a dropped customer.
- Keep cron only for genuinely time-based sweeps; let DO alarms own per-conversation timing.

This isn't a rewrite — it's migrating the orchestration spine in `webhook-handler.ts` and the
cron runners onto durable primitives. Do it before you're managing dozens of tenants, because
every reliability gap below is really a symptom of hand-rolled scheduling.

---

## Part 2 — Weak links & where this is most likely to fail

Ranked by blast radius. Each is concrete and tied to current code.

### Security & integrity

- **P0 · Unverified webhook.** `ghl/webhook.ts:27-32` returns `Boolean(provided)` — it accepts any
  request carrying *any* value in `x-ghl-signature`/`x-wh-signature`. Impact: spoofed inbound
  messages, forced LLM spend, lead spam, poisoned history. Fix: implement GHL's real HMAC scheme
  with a constant-time compare; fail closed in production (no secret configured ⇒ reject, not
  `return true`). This is also `TODO.md:11`.
- **P1 · No per-tenant rate limiting or cost ceiling.** A spammy lead or a runaway tenant can
  drive unbounded model + GHL spend. Add per-conversation and per-tenant budget guards (messages/
  min, daily token/cost cap) with graceful degradation (queue or soft-decline) when exceeded.
- **P1 · OAuth callback CSRF is acknowledged-but-open.** `mastra/index.ts:40-44` generates `state`
  but never stores/compares it. Close the loop (store nonce, verify on callback).
- **P2 · Single shared model API key across all tenants** (env-driven). Fine now, but there's no
  per-tenant cost attribution (token usage isn't captured on `messages`). Capture usage per turn
  for billing/limits later.

### Reliability of a single turn

- **P0 · Debounce is not durable.** `webhook-handler.ts:377-383` schedules the agent run via
  `setTimeout(…DEBOUNCE_MS)` inside `ctx.waitUntil`. If the isolate is evicted or the worker dies
  in that 8s window, the run is lost — no reply, no follow-up scheduled, no trace. `waitUntil` is
  best-effort and time-bounded. Durable Objects alarms fix this.
- **P0 · A model outage silently drops the customer.** On `agent.generate` failure
  (`webhook-handler.ts:221-233`) we log an error and return 500 — but nothing retries, and the
  lead never gets a reply. There is no dead-letter path. With a queue this becomes an automatic
  retry; consider provider failover (openai⇄anthropic) for hard outages.
- **P1 · Double LLM call per turn.** The status classifier (`classifyConversationOutcome`) is a
  second model round-trip on top of generation — more latency, cost, and another failure surface.
  (See `status-classification-and-ghl-pipeline-sync.md` for the plan to keep it but tighten it.)
- **P1 · ~7+ sequential Supabase round-trips per turn** (loadRecentMessages, isBotSuppressed,
  isLatestInboundMessage, logMessage ×2, classify-write, scheduleFollowUp, setGhlMessageId,
  markDelivered…), each an HTTP hop from CF to a single Supabase region. Latency stacks into
  seconds. Mitigations: batch/parallelize independent reads, collapse writes into fewer RPCs,
  consider Hyperdrive for pooled low-latency Postgres access.
- **P1 · Phone fetch on the hot path.** `webhook-handler.ts:336` does a synchronous GHL Contacts
  API call for every WhatsApp inbound that lacks a phone, *before* debounce. Cache the phone on
  the conversation row after first lookup.

### Reliability at volume

- **P1 · Follow-up throughput ceiling.** Cron pulls `loadDueFollowUps(20)` once/minute ⇒ ~20
  follow-ups/min platform-wide. As tenants grow this backs up and follow-ups arrive late. Raise
  the batch, shard, or move to per-conversation DO alarms.
- **P1 · Unbounded history growth.** `loadRecentMessages` rebuilds full history every turn with no
  windowing or summarization. Long threads inflate token cost and eventually hit context limits.
  Add a rolling window + periodic conversation summary.

### Correctness & process hygiene

- **P0 · Orchestration logic is essentially untested.** The eval suite (`front-desk.eval.ts`) is
  prompt-string assertions plus two live smell-tests. The code most likely to break — webhook
  parsing, dedup, suppression, the debounce gate, follow-up tier transitions, echo detection — has
  no unit tests. "Reliability is a first-class feature" needs a test harness behind it. Add unit
  tests for the orchestration layer and a golden-conversation regression set (see Part 5).
- **P1 · Duplicate migration number.** Two `0013_*` files (`0013_expand_conversation_status.sql`,
  `0013_human_takeover.sql`). Ordering/tracking footgun on `db reset` and prod migration state.
  Renumber one.
- **P1 · No staging environment / deploy gate.** `TODO.md` flags staging as TBD. Agent-driven
  development is only safe with a staging Worker + an eval/regression gate that blocks regressions
  before prod (this is the safety rail that lets AI ship changes).
- **P2 · Human messages mislabeled to the model.** Human-agent turns are passed as
  `role: 'assistant'` (`TODO.md:30`), so the bot can't tell where a human spoke. Prefix or
  system-note them so handoff-and-return reads naturally.

---

## Part 3 — What's missing to actually feel like a human front desk

The mechanics work; these are the gaps between "a bot that replies" and "an assistant a client
trusts with their front desk."

- **P1 · Cross-conversation contact memory.** Today context is per-conversation history only.
  A human receptionist remembers you: your name, last visit, no-show history, preferences,
  the service you usually book. Pull GHL contact custom fields + past appointments into context,
  and persist a durable per-contact memory (Mastra memory / a `contact_memory` table). This is the
  difference between "new bot every time" and "they know me."
- **P1 · Multimodal input.** WhatsApp leads send voice notes and photos (insurance cards, IDs,
  property questions, "is this the rash you treat?"). Text-only silently drops or mishandles these.
  Add audio transcription + image understanding on inbound.
- **P1 · Frustration / sentiment-aware escalation.** A real front desk reads the room and pulls in
  a person *before* the lead rage-quits. Add a lightweight sentiment signal → proactive handoff,
  rather than waiting for the `"AGENTE"` keyword.
- **P2 · Graceful non-linear conversations.** The "paso"-driven setter flow can feel rigid when a
  lead jumps topics or asks three things at once. Make the flow resilient to interruptions and
  back-references.
- **P2 · Spam / wrong-number / out-of-scope detection.** Know when *not* to engage (avoids burning
  spend and looking foolish).
- **P2 · Human-like timing & presence.** Typing indicators, sensible pacing, not firing three
  messages in 2 seconds. Small touches that read as "a person."

---

## Part 4 — Quality control & live monitoring (the "AI watching AI" layer)

This is the heart of the one-person vision: you cannot personally read thousands of conversations,
so agents must watch the conversations and surface only what needs you. Build this as a tier:

- **P0/P1 · Observability foundation first.** Wire Mastra **storage + telemetry** (currently none —
  `mastra/index.ts` configures no storage; `_mastra.getStorage()` is falsy). Persist traces, token
  usage, latency, tool calls per turn. Everything below depends on this substrate; without it
  you're flying on `console.log`.
- **P1 · QA / Supervisor agent (async, offline).** Reviews conversations against a rubric:
  Did it hallucinate (claim a fact not in config/tools)? Follow the flow? Right tone/language?
  Miss a booking opportunity? Mishandle a frustrated lead? Score each, store the score, and flag
  the bad ones. Mastra **scorers/evals over stored traces** are the native mechanism. Sample 100%
  early, down-sample as trust grows.
- **P1 · Anomaly / drift detection.** Watch the metric distributions per tenant — booking
  conversion, opt-out rate, handoff rate, classification mix, reply latency, cost/conversation.
  Alert when a tenant moves (bookings drop / opt-outs spike often means a prompt regression or a
  bad config edit). This catches problems before the client notices.
- **P1 · Pre-send hallucination guard.** A cheap verifier that checks high-risk outbound claims
  (prices, addresses, promises) against config before delivery — block or flag. Anti-hallucination
  is currently prompt-only + the eval; a runtime guard makes it enforceable.
- **P2 · Synthetic red-team agent.** Periodically runs adversarial conversations against staging
  (price-baiting, prompt injection, edge qualification) to catch regressions proactively.
- **P2 · Owner alerting.** When the QA/anomaly layer flags something, notify Leo *in WhatsApp*:
  "Conversation with X may need you — lead seems frustrated and asked about refunds."

---

## Part 5 — Reporting & analytics

The `bot_events` table + reporting views in CLAUDE.md are the foundation; they need to be built out
and surfaced. The reserved `dashboard/` package is where this lives.

- **P1 · Per-tenant funnel dashboard:** conversations → qualified → booked → showed; response
  times; opt-out/handoff rates; follow-up effectiveness per tier; cost per conversation/booking.
- **P1 · Auto-generated owner digest.** A weekly (or daily) summary an **analytics/reporting
  agent** writes and sends via WhatsApp/email: "This week: 47 leads, 31 qualified, 12 booked, 3
  need your attention." This is the single most visible proof-of-value to clients and runs itself.
- **P2 · Cohort & A/B insight.** Which prompt version / follow-up angle / tier timing converts
  best — feed it back into the improvement loop (Part 7).
- **Prereq:** capture per-turn token usage + cost on `messages` (not captured today) so cost and
  ROI reporting is real, not estimated.

---

## Part 6 — New business functions (agent roster), value-ranked

These are the modules to add as roles/workflows. Ranked by ROI for LATAM SMB clients (clinics,
real estate, gyms). Each plugs in via the existing role abstraction + Mastra workflows.

1. **P1 · Appointment reminder & no-show reduction agent.** No-shows are the #1 revenue leak for
   clinics/gyms. Automated 24h/2h confirmations with one-tap reschedule. Almost certainly the
   highest-ROI agent you can ship — and you already have the calendar + follow-up plumbing to build
   on. **Start here.**
2. **P1 · Reschedule / cancel self-service.** Deflects the most common human-handled request;
   pairs naturally with reminders. (Reschedule/cancel functions already partly exist per git log.)
3. **P2 · Post-appointment review collection.** Reviews drive local SEO → more inbound leads. Ask
   for a Google review after a `completed` appointment. Compounding flywheel.
4. **P2 · Database reactivation / win-back campaigns.** Extend the reactivation role from
   per-thread follow-ups to "haven't seen you in 90 days" outreach across a tenant's dormant
   contacts. High revenue from existing data.
5. **P2 · Deposit / payment collection.** Further cuts no-shows and captures revenue at booking.
6. **P2 · Lead nurturing / drip education** for long cycles (real estate especially).
7. **P2 · Owner ops-assistant agent.** Leo's (and each client's) own assistant over WhatsApp:
   "how many bookings today?", "pause the bot for this contact", "what needs my attention?"

---

## Part 7 — The operating model: a one-person, AI-driven business

The vision is leverage — one person + agents running the build, the ops, and the growth. The
enablers, in order of impact:

1. **P1 · AI-assisted onboarding (the #1 scaling lever).** An onboarding agent that ingests a
   prospect's website + a short intake form and generates the `tenant_config` (services, hours,
   FAQ, tone, calendars). Turns onboarding from hours of hand-written JSON into minutes of review.
   This is what makes "hundreds of clients, one operator" arithmetically possible. Everything else
   scales linearly; this is the step-change.
2. **P1 · Agents as your dev team, made safe.** CLAUDE.md already frames the codebase as the
   product and AI as implementers — good. Make AI-driven changes *safe to ship* by adding the
   missing rails: a staging Worker, a golden-conversation regression suite, and an eval gate in CI
   that blocks merges/deploys on regression. Then agents can propose, self-verify, and ship within
   guardrails you trust.
3. **P1 · The continuous-improvement flywheel.** Conversations → trace storage → QA/eval scoring →
   failure-pattern clustering → prompt/tool/config improvements → eval gate → deploy → measure.
   Each loop turn makes every tenant's bot better. The data you own (Part 1) is the fuel; the QA
   layer (Part 4) is the engine.
4. **P2 · Self-healing operations.** The QA + anomaly agents don't just alert — they draft the fix
   (a prompt tweak, a config correction, a flagged bad tenant edit) and open it for your one-click
   approval. You become an approver, not an operator.
5. **P2 · Self-serve client surface.** Eventually clients edit their own config (hours, FAQ, tone)
   through a guarded dashboard, with the onboarding agent and validation keeping them safe — and
   you out of the loop for routine changes.

---

## Suggested sequencing

- **Now (P0 — before onboarding more clients):**
  real webhook verification · wire real `bookAppointment` · durable turn processing (DO/Queue) +
  model-failure retry · orchestration unit tests + golden regression set · fix duplicate migration.
- **Next (P1 — make it production-grade & visible):**
  observability/trace storage · QA/supervisor agent · anomaly detection · per-tenant rate/cost
  limits · reminder/no-show agent · funnel dashboard + owner digest · contact memory · AI-assisted
  onboarding · staging + eval gate.
- **Then (P2 — compounding leverage):**
  multimodal input · review-collection + reactivation + payments agents · self-healing ops ·
  self-serve client config · red-team agent.

---

## How to use this doc with your AI implementers

Each P0/P1 item is scoped tightly enough to hand to a Sonnet-driven agent as a single task. For
anything touching a role's prompt/tools, run `pnpm eval` (and the future regression set) before
and after. For the durable-execution migration, the Cloudflare Agents SDK / Durable Objects and
Queues skills available in this environment are the right references. Keep CLAUDE.md updated in the
same change as any architectural decision, per the project's own rule.
</content>
