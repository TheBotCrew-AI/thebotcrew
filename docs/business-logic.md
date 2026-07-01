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
- **`status='handed_off'`** is a **permanent** pause.
- **`bot-off` tag** on a GHL contact = permanent handoff (contact-scoped, affects all their
  conversations); removing it resumes the bot. There is no `bot-on` tag — absence means on.
  Requires the `contacts.write` scope. The bot also writes status tags back to GHL so state
  stays visible there (`ghl/tags.ts`).

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
- Booking is created via the GHL API (`bookAppointment` tool) and recorded in `appointments`.
  A GHL rejection logs a **`booking_failed`** event to `bot_events` with the GHL status/body +
  `startTime`/`calendarId`/`serviceName`, so a failed booking is diagnosable (the reason is not
  left in ephemeral Cloudflare logs). A common cause is offering a slot the model didn't get
  verbatim from `getAvailability`, so GHL rejects the unrecognized `startTime`.

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
