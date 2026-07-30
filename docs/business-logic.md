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

### 1.1 Campaign prompt variants (n:1 keyword → prompt)

One tenant can run several ad campaigns, each with its own prompt flavor, without a
monolithic prompt (migration 0036; `core/tenant.ts` `matchVariantKeyword`,
`roles/front-desk/config.ts` `resolveEffectiveOverrides`).

- **`keyword_variants jsonb`** — `{ "promo laser": "laser-promo", ... }`: inbound keyword →
  variant key. Several keywords may share a variant (n:1). Same normalizer as the trigger
  gate; when several keywords match one message, the **longest** wins.
- **`prompt_variants jsonb`** — `{ "laser-promo": {offering, qualificationNotes, ...} }`:
  variant key → **partial** overrides, merged **field-by-field** over `prompt_overrides` at
  prompt-build time (`toolInstructions` merges per key). Tone/hours/services/FAQ stay
  single-sourced. `confirmContactName` is NOT variant-overridable (it's a handler backstop
  read from base config, not prompt content); `bookingEnabled` is.
- **Orthogonal to the gate**: `trigger_keywords` decides IF the bot enters;
  `keyword_variants` decides WHICH prompt flavors the thread. Use either or both (list a
  keyword in both when gated).
- **First-touch sticky**, enforced in SQL (`app_set_prompt_variant`, COALESCE): the first
  matching message pins `conversations.prompt_variant`; later campaign keywords never switch
  it (ad attribution; no mid-thread personality swap). Read fresh each turn alongside
  `active_role`. The demo persona, when active, wins over the variant.
- Observability: `variant_assigned` event `{variant, keyword, known}`. **`known:false` is the
  misconfiguration fingerprint** — a keyword mapped to a variant key with no
  `prompt_variants` entry; the prompt falls back to base, loudly, never silently. A variant
  DB failure never blocks the turn (lead gets the base prompt).

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

> **Opt-out per tenant:** `prompt_overrides.bookingEnabled = false` turns this entire
> section off for one tenant. See § 5a — everything below assumes the default (`true`).

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
- **Appointment resolution (store-first, GHL fallback).** The lookup / reschedule / cancel tools
  resolve the contact's appointment via `resolveActiveAppointment` (`roles/front-desk/tools/`): it
  reads **our store** first (`loadLatestAppointment` — the bot's own bookings, freshest right after
  it books), and when the store has none it **falls back to GHL** (`getContactAppointments` →
  soonest upcoming, not cancelled/deleted). This is why an appointment **booked or moved directly in
  the GHL calendar** (by the client's staff, or a lead via GHL's own widget) is now visible to the
  bot — a store-only lookup used to answer "no tienes cita" even when GHL had one (bug found
  2026-07-06 on a test contact). The two sources return different keys: store → `serviceType`
  (mapped to a configured calendar); GHL → `calendarId` (reverse-mapped to a service for
  duration/logging). **Note:** the self-block turn guard (`loadActiveAppointment`) is still
  store-only by design — it only needs to catch the bot's own just-made booking.
- **Lookup (tool).** `lookupAppointment` answers "when is my appointment?" — it resolves the
  contact's appointment (store or GHL, above) and, for a store-sourced one, reads its **live**
  status/time from GHL (`getAppointment`), falling back to our recorded datetime if that read fails
  (a GHL-sourced one is already live). It returns a tenant-tz Spanish label the agent presents
  verbatim (no recomputing dates), and reports no active appointment when the row is `cancelled` or
  GHL shows it cancelled.
- **Reschedule / cancel (tools).** `rescheduleAppointment` and `cancelAppointment` act on the
  contact's **active appointment** (resolved store-first with the GHL fallback above; a newest
  store action of `cancelled` falls through to GHL). Reschedule **re-validates** the new time
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

## 2a. What `status` actually controls (read this before touching it)

`conversations.status` looks like a lifecycle enum but only **two** of its values change
behavior, and no TypeScript reads it — the logic lives in three RPCs:

| Value | Bot may reply? | Follow-ups? | A lead reply re-arms follow-ups? |
| --- | --- | --- | --- |
| `active` | yes | **yes** | — |
| `standby` | yes | no | **yes** |
| `completed` | yes | no | **yes** |
| `opted_out` | yes | no | **no** (consent) |
| `awaiting_human` | yes | no | **no** (we owe them) |
| `handed_off` | **no** | no | **no** (only a human releases it) |

- `app_is_bot_suppressed` mutes on **`handed_off` only** (plus the human 5-min timer).
- `app_schedule_follow_up` and `app_load_due_follow_ups` both require **`status = 'active'`**.

So "reactivating" is **not** resuming the conversation — the bot was never stopped. It is
**re-arming automated nudges**, and that is the only question worth asking when adding a
value: *may we message this lead unprompted again?* (Migration 0035 fixed the answer for two
cases; `opted_out` used to reactivate, which meant a lead who said "stop" could re-enter the
nudge ladder just by writing again.)

**Known overlap, not yet resolved:** `status` still conflates three orthogonal things — who
may speak, the commercial outcome (duplicating the `outcome` column: 196 rows are
`active` + `appointment_booked`), and follow-up eligibility. A refactor into separate fields
(`bot_muted_until`, `outcome`, `awaiting_human_since`) is on the table but deliberately
deferred. Until then, resist adding values: only add one if its **reactivation semantics**
differ from every existing value, which is the bar `awaiting_human` met.

## 5a. Tenants that don't book through the bot (`bookingEnabled: false`)

Some tenants have **no calendar the bot can trust**. MADI Skin Care is the reference case:
she has no premises of her own — she rents a laser booth on a third party's shared calendar,
which several other renters also book. There is nothing for `getAvailability` to read, so any
time the bot offered would be a guess.

For these tenants set `prompt_overrides.bookingEnabled = false`. The bot then **collects the
request and hands off** instead of booking:

1. Capture ONE preference with a closed question ("¿mañana o tarde?").
2. Tell the lead availability is being checked and a confirmation is coming shortly —
   with no day, no hour, and no promised response time.
3. Call `updateConversationStatus('handed_off')` as the last step of the turn.

That is the `flagAwaitingHuman` tool, and it does three things: sets `awaiting_human`
(follow-ups off, **bot NOT muted**), writes the tenant's `awaiting_human_tag` on the GHL
contact, and logs an `awaiting_human` event with the request summary so time-to-attention is
measurable.

**Closing the loop:** the owner **removing the tag** in GHL is what returns the conversation
to `active` (ContactTagUpdate → `worker/tag-handler.ts` → `app_set_awaiting_human_by_contact`).
The real "I've handled this" action drives the state, instead of the model guessing when a
request stops being pending. It never overrides `handed_off` or `opted_out` — stronger signals.

**Do not use `handed_off` for this.** It mutes the bot permanently *and* is excluded from
`app_reactivate_conversation`, so the lead's next message hits silence with no way back except
a human. That combination produced a real dead end on 2026-07-29: the bot asked "¿mañana o
tarde?" and muted itself in the same turn, so the answer — and a follow-up pricing question it
could have answered from config — went unanswered. Hence the two-turn rule in the prompt, and
hence this flow never touching a muting status.

**Two layers enforce it**, because a prompt instruction alone is not a guarantee:
- **Prompt (`bookingEnabled: false`)** — strips the booking sections from the shared prompt
  entirely (`BOOKING_SECTIONS` → `NO_BOOKING_SECTION` in `roles/front-desk/prompt.ts`), along
  with the booking horizon, the reminder-number ask (there's no `bookAppointment` call left to
  carry the number) and the existing-appointment guard. Leaving them in place would have the
  base prompt insisting *"cuando el lead pida cita, llama getAvailability"* **after** the
  tenant's own "don't book" rules — the exact contradiction that makes a bot promise a slot.
- **Config (`tenant_config.calendars = '{}'`)** — deterministic backstop. With no calendar
  mapped, `getAvailability` and `bookAppointment` structurally cannot return or reserve
  anything even if the model calls them anyway.

Trade-off to know, by design: **these leads get no automated nudges** while the tag is on. If
the owner never gets back to them, nobody chases. That is deliberate — we owe them the answer,
so a "¿sigues interesada?" would be backwards — but it means the tag is a **work queue that
someone has to actually work**. Measure it:

```sql
select created_at, metadata->>'summary' as pidio
from bot_events where event_type = 'awaiting_human'
order by created_at desc;
```

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
  activation keyword instead of treating it as a question. **Idempotent (0037):** re-matching the
  on-keyword mid-demo keeps the original stamp — before 0037 it re-stamped `now()` on every
  match, truncating history to zero mid-conversation ("demo amnesia").
- **Roleplay never touches real state (0037 hardening).** A demo conversation is fiction, so
  while `active_role='demo'`:
  - the outcome **classifier is skipped** — a roleplayed "ya no me interesa" must not set the
    real conversation `opted_out` (which would survive the demo via the 0035 reactivation rules)
    or tag the real GHL contact;
  - **follow-ups are not scheduled** — the reactivation agent is persona-blind (full history,
    normal tenant config + angles); a nudge mid-demo shatters the roleplay. They resume once the
    conversation leaves demo;
  - the **contact-name backstop is skipped** — demo-truncated history re-opens the "opening
    exchanges" window, and a roleplay name must never overwrite the real contact's name;
  - the three side-effect tools (`updateConversationStatus`, `updateContactName`,
    `flagAwaitingHuman`) **no-op and pretend success**, and the demo prompt replaces the
    terminal-state instructions with a "sin efectos reales" rule.
- **Off by default & safe.** If a tenant sets no demo keywords, nothing changes. `off` returns to
  the normal front-desk (to fully silence a thread, use the `bot-off` tag instead).

## 5c. Demo sessions — the lead-magnet funnel (0038)

Budgeted, per-lead self-demos: an ad lead gets a live demo of a bot **for their own
business**, then the normal persona (the closer) takes over to book a real call. Runs on the
Bot Crew's own tenant; gated per tenant by `tenant_config.demo_sessions_enabled`
(default **false** — no other tenant is affected). Manual keyword demos (§5b) are unchanged
and never create sessions.

**Flow.**
1. Ad → `wa.me` link with a static keyword (e.g. "DEMO"). The keyword doubles as the
   `trigger_keywords` entry gate — no special-casing in the gate order.
2. The NORMAL persona does the intake conversationally (business name, giro, services —
   enriched from the form contact when the phone matches) and calls the **`startDemo`
   tool**, which builds the persona from a TEMPLATE (`roles/front-desk/demo-persona.ts` —
   deliberately not an LLM call: deterministic, instant, testable, and lead text is embedded
   as length-capped DATA, shrinking the prompt-injection surface; `persona_version` tracks the
   template) and calls `app_create_demo_session`: session row + `active_role='demo'` flip,
   atomic. The announcing turn still speaks as the normal persona ("escríbeme como si fueras
   un cliente…"); the lead's next message is answered in character.
3. Each turn while in demo reads the session fresh: the generated persona is overlaid onto
   `demoPromptOverrides`, and **budget + expiry** are enforced BEFORE generating. Budget =
   bot message PARTS since activation (derived by counting `messages`, self-healing — no
   counter to drift under the debounce), default 15; expiry default 48h, enforced lazily at
   turn time (an abandoned demo just sits until the lead writes again).
4. Exhausted/expired → `app_end_demo_session`: session ended + flip to `active_role=NULL`,
   atomic. The turn re-reads the persona and answers as **the closer** — the tenant's normal
   front-desk — with a `demoHandoff` prompt section (what business, why it ended: ask how it
   went, offer a REAL call via the normal booking tools). Follow-ups re-arm from the closer
   turn (they are OFF during demo, §5b).

**Clean-start via `role_started_at`.** 0038 generalizes `demo_started_at`: every persona
TRANSITION stamps `conversations.role_started_at` **at the latest inbound message** (not
`now()` — the message that caused the flip is already logged, so a `now()` stamp would hand
the new persona an empty history). History always loads from `role_started_at` when set, so
the demo doesn't see pre-demo context and the closer doesn't see the roleplay — only the
lead's last message plus the handoff section. `demo_started_at` is still written (legacy
fallback for turns racing the deploy); drop it in a later release (expand/contract).

**Simulated booking.** While `active_role='demo'` (sessions AND manual demos), the five
booking tools never touch GHL or the real store (`tools/demo-sim.ts`): `getAvailability`
returns plausible slots, deterministic per conversation+day (re-queries agree; 1-2 slots/day
"taken" so the calendar reads real; Sundays closed); `bookAppointment` enforces the same
only-exact-slot rule as the real path (`resolveBookableSlot`) and stores the booking on the
session (`simulated_booking`); lookup/reschedule/cancel operate on that stored booking. No
GHL error can fire mid-pitch, nothing to clean up, and a manual demo can no longer book a
REAL slot by accident.

**Launch checklist (Bot Crew tenant — all config, no deploy):**
- `demo_sessions_enabled = true`; qualificationNotes teach the intake→startDemo flow.
- **Clear `test_contact_ids`** — test mode outranks every other gate; leaving it set silently
  drops every real lead (`test_mode_skip`).
- `whatsapp ∈ enabled_channels`; the ad keyword in `trigger_keywords`.
- **Front-load `follow_up_cadence`** (e.g. 30m/3h/18h): outside WhatsApp's 24h window,
  free-form sends fail at Meta's layer — a multi-day cadence just logs delivery errors.

Observability: `demo_session_started` / `demo_session_ended` (`{reason, botMessagesUsed}`) in
`bot_events`; sessions keep `lead_data` + `persona_version` for cohort comparison.

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
