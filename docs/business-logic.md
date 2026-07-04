# Business Logic — The Bot Crew Agent Platform

> The **rules that govern agent behavior**, separate from `CLAUDE.md` (which covers
> architecture, stack, and conventions). Read this to understand *what the bot does and
> why*, without reverse-engineering it from code.
>
> **Maintenance rule (non-negotiable):** when a change alters any behavior described here,
> update this file **in the same change** — same standard as `CLAUDE.md`. Each rule points
> to where it is enforced so the doc stays anchored to the code. If code and this doc
> disagree, the code is the truth and this doc is a bug — fix it.

---

## 1. Reply gating — when the bot is allowed to answer

Inbound messages are **always stored**; only the *reply* is gated. Enforced in
`worker/webhook-handler.ts`; helpers in `core/tenant.ts`. Gate order: **channel / test → keyword**.

- **`enabled_channels text[]`** — channels the bot may reply on. **`NULL` = none** (installed
  but silent; the onboarding default — new tenants are born silent). Set e.g. `{facebook}` to
  go live on one channel.
- **`test_contact_ids text[]`** — pre-live allowlist. When non-empty, the bot replies **only**
  to those GHL contact ids, on **any** channel (bypasses the channel gate). Used to test with
  your own contacts before going live.
- **`trigger_keywords text[]`** — entry gate (e.g. an ad CTA "manda Agente"). When non-empty,
  the bot only **enters** a conversation whose message contains a keyword (whole-word/phrase,
  case- & accent-insensitive). It's an entry gate, not per-message: once activated
  (`conversations.bot_activated`), the thread flows without the keyword.

Each blocked turn is logged to `bot_events` (`channel_disabled`, `test_mode_skip`,
`keyword_required`, `bot_activated`) so you can see *why* the bot stayed quiet.

## 2. Conversation lifecycle

Statuses (`conversations.status`): `active`, `standby`, `completed`, `opted_out`,
`handed_off`, `closed`.

- The front-desk agent sets terminal states via its `updateConversationStatus` tool:
  `standby` (not qualified / not ready), `completed` (booked or done), `opted_out` (asked to
  stop), `handed_off` (escalated to a human). Setting a terminal state **atomically cancels
  pending follow-ups** and logs a **`status_changed`** event (`{from,to}`) — both in
  `app_update_conversation_status`, so every state change (agent tool or follow-up runner) is
  traceable. (A "silent standby" — agent ending a fresh lead with no reply — is visible here.)
- A silent conversation in `standby`/`completed`/`opted_out` is **reactivated to `active`**
  when the lead messages again (`app_reactivate_conversation`). `active` and `handed_off` are
  untouched by reactivation.

## 3. Human takeover & kill switch

Hybrid human ↔ AI. Enforced by `isBotSuppressed`, re-checked again right before send
(anti-double-message). See `worker/outbound-handler.ts`, `worker/tag-handler.ts`.

- **Human reply** (`source:'app'` outbound webhook) opens a **5-minute sliding pause**
  (`conversations.human_active_until`). Each human message extends it.
- **Cold-outreach opener exception.** If a `source:'app'` message is the conversation's
  **first** message (`conversationMessageCount == 0`), it's an outreach opener — e.g. a WhatsApp
  template Leo sends to open the 24h window on a **new** contact — not a human taking over an
  ongoing thread. It's still logged (history context; maps to an assistant turn) but does **not**
  open the pause, so the bot answers the lead's reply. A real takeover happens mid-thread and
  still pauses. (Fixed the 2026-07-02 "template opener → lead replies → bot muted 5 min" bug.)
- **`status='handed_off'`** is a **permanent** pause.
- **`bot-off` tag** on a GHL contact = permanent handoff (contact-scoped, affects all their
  conversations); removing it resumes the bot. There is no `bot-on` tag — absence means on.
  Requires the `contacts.write` scope. The bot also writes status tags back to GHL so state
  stays visible there (`ghl/tags.ts`).
- **Bot-echo guards.** GHL echoes our *own* API sends back on the outbound webhook as
  `source:'app'`, so before treating an outbound as a human takeover the handler ignores it if
  (a) its GHL message id matches a stored bot message (`isBotMessageById`), or (b) — backstop —
  its content matches a bot message sent to that conversation in the last 90s (`isRecentBotEcho`).
  (b) catches an accepted send whose id we couldn't capture; without it that echo would open a
  false 5-min pause (see §7, 2026-07-01 double-send).

- **Contact-merge recovery (send).** GHL dedups contacts by phone/email. An Instant-Form ad lead
  whose number already exists as another contact (e.g. a prior WhatsApp contact) gets **merged**,
  and the `contactId` from the inbound webhook is deleted → the outbound send fails
  `CONVERSATIONS_CONTACT_NOT_FOUND`. `GhlClient.sendMessage` recovers: on that error it re-resolves
  the conversation's **current** contactId (`GET /conversations/{id}`, which GHL re-parents to the
  surviving contact), retries the send once, and reports `resolvedContactId`; the turn persists it
  (`updateConversationContact`) so later parts/turns/follow-ups use the valid id. All three send
  paths (turn, delivery-retry cron, follow-up) pass the conversationId so they self-heal. Note:
  mostly a returning/cross-channel-lead case in production — self-tests that reuse one phone hit it
  every time (all collapse into one contact).

## 4. Follow-ups (reactivation)

Tenants **opt in** via two **decoupled** config fields (absent/null = no follow-ups). Runner:
`worker/followup-runner.ts` (1-min cron); the text-only **reactivation** role (no tools) writes
each message.

- **`follow_up_cadence`** (jsonb `number[]`, minutes) — the **timing/attempt** ladder within a
  *cycle*, e.g. `[15,180,360,720]`. Controls when nudges fire and how many per cycle.
- **`follow_up_angles`** (jsonb `string[]`) — a **content** pool of angle directives, decoupled
  from timing. Can be longer than the cadence.

Why decoupled: a "tier" used to fuse timing + angle, so the cycle resetting on every reply also
reset the angle → the same angle repeated each cycle (felt repetitive). Now the two advance
independently.

Core mechanics — **one follow-up at a time**:

- Cadence position 1 is scheduled after every bot reply (`webhook-handler.ts`); the RPC no-ops if
  the conversation isn't `active`. Each next position is scheduled **only after** the previous one
  sends (`followup-runner.ts`). Never more than one `pending` row per conversation.
- **Every inbound message cancels all pending follow-ups** (`app_cancel_follow_ups`) and the next
  bot reply restarts the cycle at position 1 — so a lead who keeps re-engaging keeps getting fresh
  attempts (the cadence **clock resets**).
- **The freno:** when a cadence cycle is exhausted **with no reply**, the conversation goes to
  `standby`. So an unresponsive lead gets at most `cadence.length` nudges per silence; replying is
  what "refuels" a new cycle. The stop condition is the lead going silent through a full cycle.

The reactivation agent is text-only (no `getAvailability`, no booking horizon): it **never
proposes dates/days/timeframes** (e.g. "next week") — doing so contradicts what the front-desk
can actually book. It only baits a reply; scheduling/availability is entirely the front-desk's.

**Angle progression (never repeats):** at send time the runner offers the reactivation agent only
the pool angles **not yet sent** on this conversation (`loadSentAngleIndexes`, keyed on
`follow_ups.angle_index` where `status='sent'` — cancelled/undelivered never count). Selection is
**hybrid**: the agent picks the best-fitting unused angle for the current context and reports its
choice via a machine-readable `ANGULO: n` tag (parsed + stripped in `roles/reactivation/
angle-select.ts`, with a deterministic "next unused" fallback). When the pool is exhausted it
free-forms a fresh nudge (`angle_index` NULL). Because this cursor persists across cycles, a reset
cycle keeps advancing to new angles — the "4 more attempts" never feel repetitive.

### 4.1 Quiet hours (DND) — never message overnight

A follow-up whose computed send time (`now + delayMinutes`) lands inside the tenant's quiet
window is **pushed forward to when the window ends** (default 08:00 local). Enforced at the
single scheduling choke point `scheduleFollowUp` via the pure helper
`core/active-hours.ts` (`clampToActiveHours`).

- **Default window: 21:00–08:00** tenant-local (`DEFAULT_QUIET_HOURS`).
- **Per-tenant override:** `tenant_config.quiet_hours` jsonb `{"start": 22, "end": 7}` (local
  hours 0–23). `NULL` = platform default. No redeploy to change.
- Because each tier is scheduled relative to when the previous one *actually* sent, clamping
  one tier shifts the whole chain forward — **no cascading to handle**. Windows that cross
  midnight are handled (`hour >= start || hour < end`).

## 5. Availability & booking

Tool: `getAvailability` (`roles/front-desk/tools/get-availability.ts`) → real GHL calendar
slots. Rules (also reinforced in the front-desk prompt):

- The agent **must call `getAvailability` before offering or confirming any time**, and may
  only offer/confirm a time that came **verbatim** from a result (no inventing/extrapolating
  dates like "next week"). Enforced in the front-desk prompt (§ Disponibilidad).
- **Booking horizon (deterministic, per-tenant):** `tenant_config.booking_horizon_days` (int,
  NULL = no cap) is enforced in the tool via the pure `resolveBookingWindow`
  (`tools/booking-window.ts`): the requested range is clamped to `now + N days`, and a range
  starting entirely beyond it returns an `out_of_horizon` note the agent relays to the lead.
  This does **not** rely on the model — the tool never even queries GHL past the horizon. The
  horizon date is also **surfaced in the prompt** (`# Fecha y hora actuales`, pre-computed — no
  model date math), so the agent sets expectations up front instead of silently offering
  near-term slots when a lead asks for a later date.
- **Timezone:** slot labels are formatted in `tenant_config.timezone`, which **must match the
  GHL calendar's timezone** (else labels are offset — e.g. a Pacific calendar shown in CDMX is
  +1h wrong). The Bot Crew's calendar is `America/Tijuana`.
- Slots are labeled **in code** in the tenant's timezone (correct weekday); the agent presents
  the `label` **verbatim** and never recomputes/translates a date. Dates are grounded from the
  prompt's "today" line — the model never does weekday math.
- **Never claim a specific time is unavailable unless it's absent from the returned labels**,
  and never mix a "no availability" preamble with a list that contains slots. (This rule exists
  because gpt-4o-mini once said "11:30 no disponible" then listed 11:30 first — see §7.)
- Every check logs the **raw slots GHL returned** to `bot_events`
  (`event_type = 'availability_checked'`), so an availability claim can be audited against
  ground truth instead of inferred. Query by `conversation_id`.
- **Reminder number (confirm/capture before booking).** GHL sends confirmation/reminder
  templates to the contact's `phone`. WhatsApp leads arrive with a number; **FB/IG leads carry
  no phone**. The turn resolves the number on file (`parsed.phone ?? getContactPhone(contactId)`)
  and the front-desk prompt is injected accordingly: **if the contact already has a phone, the
  agent leaves it untouched** — it does NOT ask, confirm, or offer to change it, just books; **if
  there's no phone (typical FB/IG lead), it asks for it** (with country code) at booking. The
  number is written **only as the `whatsappPhone` argument of `bookAppointment`**
  (`updateContactPhone`, needs `contacts.write`) — no standalone save tool, so it can't be stored
  before an actual booking. **The tool NEVER overwrites an existing phone** (writes only when the
  contact has none): changing a WhatsApp contact's number breaks the 24h messaging window — Meta
  treats it as a new number with no lead interaction, so the bot can no longer reply (templates
  only). Two layers enforce this: the prompt (don't pass `whatsappPhone` when a number exists) and
  the tool (skip the write if `getContactPhone` returns anything). The write is non-blocking (a
  failure still lets the appointment go through). This also removed an earlier class of bugs where
  gpt-5-mini scraped the number from a lead-form message and saved it prematurely (→ GHL
  dedup/merge → stale contactId).
- **Booking sequence (prompt-enforced):** once the lead picks a time already validated by
  `getAvailability`, the agent must **not** re-run `getAvailability` or re-offer slots — it goes
  straight to confirm/capture the number → `bookAppointment` → confirm. When it *does* offer
  slots, the list must be in the **same message** as the intro (no bare "tengo estos horarios:"
  with no slots). The turn runs with `maxSteps: 8` so a full booking chain (getAvailability +
  bookAppointment [which also saves the reminder number] + updateConversationStatus + final
  reply) doesn't exhaust steps and emit only a truncated pre-tool intro.
- **After booking, the agent closes and goes quiet (prompt-enforced).** The confirmation is a
  short close: day + time + "you'll get the confirmation/reminders on WhatsApp" — then it stops.
  It must **not** ask a trailing question, try to "advance" the conversation, or offer to send
  anything not in tenant config (no invented agenda, Zoom/Meet link, topics list, prep materials).
  It also calls `updateConversationStatus(completed)`, which cancels pending follow-ups so the bot
  doesn't keep poking a booked lead. (It still replies normally if the lead writes again.)
- **Already-booked guard (turn-start, deterministic — anti self-block).** Before generating,
  the turn resolves the contact's **active** appointment (`loadActiveAppointment` = newest
  `appointments` row that is **not cancelled AND whose start time is still in the future** — past
  appointments never count, so a lead who booked earlier in the year isn't blocked from booking
  again) and injects it into the prompt. When present, the agent is told: **do not call
  `getAvailability` or re-offer times; if the lead just chats/clarifies, reconfirm that same
  appointment; never say that time "ya no está libre" — it's the lead's own booking.** This kills
  the self-block class (see §7): a second turn firing right after a booking would otherwise
  re-check availability, see its own just-created appointment missing from GHL's open slots, and
  "correct" itself with alternatives. The guard reads **our store** (fresh in exactly that
  scenario; no live GHL call per turn) and is **skipped in demo mode** (clean-start — the demo
  must not inherit a real prior booking). Reschedule/cancel still override it on an explicit
  request.
- **Lookup (tool).** `lookupAppointment` answers "when is my appointment?" — it resolves the
  contact's active appointment (`loadLatestAppointment`) and reads its **live** status/time from
  GHL (`getAppointment`), falling back to our recorded datetime if the GHL read fails. It returns a
  tenant-tz Spanish label the agent presents verbatim (no recomputing dates), and reports no active
  appointment when the newest row is `cancelled` or GHL shows it cancelled.
- **Reschedule / cancel (tools).** `rescheduleAppointment` and `cancelAppointment` act on the
  contact's **active appointment** (`loadLatestAppointment` = newest `appointments` row with a GHL
  id; a newest action of `cancelled` = none active). Reschedule **re-validates** the new time
  against real `getAvailability` (same anti-hallucination guard as booking, and within the booking
  horizon) before moving it, then logs a `rescheduled` row. Cancel is a **soft** GHL cancel
  (`appointmentStatus='cancelled'`, not a delete), logs a `cancelled` row, and **reopens** the
  conversation (`reactivateConversation`) so the bot can offer to rebook. Prompt rules: the agent
  must **confirm explicitly before cancelling** (never on an ambiguous message) and must call
  `getAvailability` before rescheduling. No schema change — `appointments.action` already allowed
  `rescheduled`/`cancelled`.
- Booking is created via the GHL API (`bookAppointment` tool) and recorded in `appointments`.
  A GHL rejection logs a **`booking_failed`** event to `bot_events` with the GHL status/body +
  `startTime`/`calendarId`/`serviceName`, so a failed booking is diagnosable (the reason is not
  left in ephemeral Cloudflare logs). A common cause is offering a slot the model didn't get
  verbatim from `getAvailability`, so GHL rejects the unrecognized `startTime`.

## 5b. Demo persona (per-conversation role switch)

A conversation can be flipped between the tenant's normal front-desk agent and a **demo
persona**, controlled by keywords — useful for showing the bot to a prospect on your own number.

- **Same engine, different brain.** The demo runs on the same front-desk agent (same tools:
  availability, booking, etc.) — only the prompt/persona changes. Its persona comes from
  `tenant_config.demo_prompt_overrides` (same shape as `prompt_overrides`: identity, offering,
  qualificationNotes, tone, toolInstructions).
- **Toggle by keyword (any sender).** An inbound matching `tenant_config.demo_on_keywords`
  switches the conversation into demo (`conversations.active_role='demo'`); one matching
  `demo_off_keywords` switches it back (`active_role=NULL`). Matching is whole-word/phrase,
  case- & accent-insensitive (same `messageMatchesTrigger`). The flip happens **before** the turn
  runs, so that same message is already answered by the selected persona. Anyone can turn it
  on/off (the prospect enters via the keyword; the prospect or the operator can exit).
- **How it's wired.** `handleInboundWebhook` calls `setActiveRole` on a keyword match (logs a
  `demo_toggled` event); the turn reads `active_role` fresh (`getActiveRole`) and
  `buildFrontDeskInstructions` swaps in `demo_prompt_overrides` when `active_role='demo'`.
- **Clean start.** Flipping into demo stamps `conversations.demo_started_at`; the turn then loads
  **only** messages since activation (`loadRecentMessages(..., sinceTs)`), so the demo persona
  doesn't inherit pre-demo history (e.g. a completed booking). The demo prompt also greets on the
  activation keyword instead of treating it as a question.
- **Off by default & safe.** If a tenant sets no demo keywords, nothing changes. `off` returns to
  the normal front-desk (to fully silence a thread, use the `bot-off` tag instead). Follow-ups and
  classification still apply during demo (same engine).

## 6. Models & factual grounding

- **Platform default: `openai` / `gpt-5-mini`** (`DEFAULT_PROVIDER` / `DEFAULT_MODEL` in
  `roles/front-desk/agent.ts`). Per-tenant override in `tenant_config.ai_provider` /
  `ai_model`; `NULL` inherits the default.
- **Anti-hallucination rule:** agents only state facts present in tenant config or returned by
  tools. No invented prices, addresses, hours, availability, or promotions. When unsure, say so
  and offer to connect a human.
- Client-facing agent content defaults to **Spanish**.

## 7. Known incidents & rationale

Short log of *why* certain rules exist, so they aren't "simplified away" later.

- **2026-07-01 — false unavailability.** A front-desk reply said "a las 11:30 no tengo
  disponibilidad" then listed "11:30 a.m." as the first offered slot. Root cause: `gpt-4o-mini`
  contradicting its own tool output, **not** a real calendar gap. Fixes: raised default model
  to `gpt-5-mini`, added `availability_checked` logging (§5), and the strict availability
  prompt rule (§5). Conversation `d5ba232b-d955-4104-a385-8e99471b0965`.
- **2026-07-01 — double send + false takeover.** A front-desk reply reached the lead twice.
  Root cause: `sendWithRetry` retried a send GHL had actually **accepted** (the first attempt
  looked failed on our side — a 2xx whose id we couldn't parse, or a network blip after commit),
  and GHL's send API isn't idempotent. The un-captured duplicate echoed back as `source:'app'`
  and was logged as a **human takeover**, opening a false 5-min pause (which also self-silences
  the bot). Fixes: never retry after a 2xx — treat *accepted-without-id* as delivered so neither
  the inline retry nor the pending cron re-sends (`webhook-handler.ts`); plus a content+recency
  echo guard (`isRecentBotEcho`, §3). Residual: a raw network error after GHL commits still
  double-delivers — only true send idempotency closes it (deferred). Frequency at time of fix: 1
  in ~26k. Conversation `5a2ab928-d8a9-4eac-abe8-9fa0fa93db7e`.
- **2026-07-01 — reconciliation double-run (second double-send source).** A single inbound
  logged **two** `availability_checked` events ~43s apart: the debounced turn was abnormally
  slow (~58s from tool-call to logged reply), so it hadn't recorded a reply when the
  reconciliation sweep's 45s min-age elapsed — the inbound still looked "unanswered," so the
  cron re-ran (and re-sent) the same turn. Distinct from the inline-retry bug above. Fix: the
  live turn now claims `reconcile_claimed_at` at the start of `runAgentTurn` (before generate),
  so the sweep's cooldown skips an in-flight turn (§2 / CLAUDE.md turn-durability). Also, a
  swallowed `scheduleFollowUp` failure (a delivered reply left with no follow-up) now emits a
  `db_error` event (`stage:'schedule_follow_up'`) instead of vanishing into Cloudflare logs.
- **2026-07-04 — self-block on own booking (sequential re-run).** The bot offered 2:30 p.m.,
  booked it, confirmed ("Nos vemos… 2:30"), then **24s later contradicted itself**: "el 2:30 ya
  no está libre" and offered 3:30/3:45/4:00. Timeline from `bot_events`: the lead's pick "2.30"
  fired turn A (booked 2:30, `lead_qualified` at 15:59:06); her two trailing clarifications
  ("Para mí", "Es hora pacífico") arrived **17s** after "2.30" — past the DO's 15s debounce — so
  they fired a **second turn B**. Turn B re-ran `getAvailability`, and because turn A had **just
  booked 2:30**, GHL no longer returned that slot (89 → 82 slots); the model read the gap as
  "taken" and self-corrected. Note: the Durable Object killed the *concurrent* double-run (B
  waited for A), but **serialization does not prevent a sequential re-run** contradicting the
  first. Root causes: (1) a post-booking turn re-checking availability, and (2)
  `getAvailability` can't tell "taken by someone else" from "taken because I just booked it."
  Fix: the **already-booked guard** (§5) — inject the contact's active future appointment at
  turn start and forbid re-checking/re-offering. Conversation `8pfXVxb3mTjh9j49RCXE`.
