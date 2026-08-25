# Onboarding a new tenant

> The full, no-exploration-needed procedure for putting a new client live.
> Everything here is data + a GHL install — **no code change, no redeploy**.
> Business rules the config feeds into live in [`business-logic.md`](business-logic.md).

## The URLs you always forget

The Worker has **no custom domain yet** (see `TODO.md` → Infra). It lives on the
account's `workers.dev` subdomain, which is `floral-credit-be7e`:

| What | URL |
| --- | --- |
| Worker base | `https://thebotcrew-agents.floral-credit-be7e.workers.dev` |
| **GHL app install** | `<base>/oauth/ghl/install` |
| OAuth callback (GHL app config) | `<base>/oauth/callback` |
| InboundMessage webhook | `<base>/webhooks/ghl` |
| OutboundMessage webhook | `<base>/webhooks/ghl/outbound` |
| ContactTagUpdate webhook | `<base>/webhooks/ghl/tags` |

The subdomain is not stored in the repo. To re-derive it:
`curl -H "Authorization: Bearer $(grep -m1 '^oauth_token' ~/Library/Preferences/.wrangler/config/default.toml | sed 's/.*= *"//; s/"//')" \
 "https://api.cloudflare.com/client/v4/accounts/cc283929a3469ed5084692cc58bc0c16/workers/subdomain"`

Supabase project: **`ywkdlsfdxnqftbalglov`** (`thebotcrew`, us-east-2).

## Order of operations (it matters)

```
1. Seed DB (client → tenant → tenant_config)   ← silent: enabled_channels NULL
2. Install the GHL app on the subaccount        ← needs step 1 or it 404s
3. Read the tenant's real calendar IDs           ← needs step 2 (OAuth token)
4. Test with test_contact_ids
5. Go live: set enabled_channels
```

**Step 2 fails without step 1.** `/oauth/callback` resolves the tenant by
`locationId`; with no `tenants` row it returns `{"error":"unknown_location"}` and no
token is stored.

---

## 1. Seed the DB

One statement, transactional — if any part fails nothing is written. Replace the
bracketed values.

```sql
with c as (
  insert into clients (name, niche, country, is_active, active_since)
  values ('<Client Name>', '<niche>', 'MX', true, current_date)
  returning id
), t as (
  insert into tenants (client_id, ghl_location_id, is_active)
  select c.id, '<GHL locationId>', true from c
  returning id
)
insert into tenant_config (
  tenant_id, business_name, timezone, tone,
  services, hours, calendars, faq,
  enabled_roles, prompt_overrides,
  enabled_channels, test_contact_ids, trigger_keywords,
  booking_horizon_days, follow_up_cadence, follow_up_angles
)
select t.id,
  '<Business Name>', 'America/Tijuana', null,
  '[...]'::jsonb,    -- services
  '{...}'::jsonb,    -- hours
  '{}'::jsonb,       -- calendars — filled in step 3
  '[...]'::jsonb,    -- faq
  array['front-desk'],
  '{...}'::jsonb,    -- prompt_overrides
  null, null, null,  -- enabled_channels / test_contact_ids / trigger_keywords
  7,                 -- booking_horizon_days
  '[15,180,360,720]'::jsonb,
  '[...]'::jsonb     -- follow_up_angles
from t;
```

### Column gotchas

- `follow_up_cadence` and `follow_up_angles` are **`jsonb`**, not `text[]` — a bare
  `array[...]` literal fails with `42804`. `enabled_channels`, `test_contact_ids` and
  `trigger_keywords` *are* `text[]`. Easy to mix up; the error is loud, not silent.
- Use dollar-quoting (`$json$…$json$::jsonb`) for the prompt blobs. Prices like `$999`
  never collide with the `$json$` delimiter.
- `timezone` is an IANA name and drives every slot label (`America/Tijuana`,
  `America/Mexico_City`, …). Getting it wrong silently shifts every offered time.

### What each field actually does

| Field | Effect |
| --- | --- |
| `hours` | **Always rendered** into the prompt as `# Horario`, even when `prompt_overrides.offering` is set. |
| `services` | Rendered **only if** `prompt_overrides.offering` is absent — `offering` replaces that whole section. |
| `calendars` | `{ "<service name>": "<GHL calendar id>" }`. `getAvailability`/`bookAppointment` look up the **exact string** the model passes as `serviceName`. A miss returns "No hay un calendario configurado" and the bot cannot book. |
| `faq` | Fed to the `lookupFaq` tool, not inlined into the prompt. |
| `booking_horizon_days` | Deterministically clamps `getAvailability`, and the prompt states the cutoff as a pre-computed date. `NULL` = no cap. |
| `quiet_hours` | `NULL` = platform default 21:00–08:00 local. |
| `follow_up_rounds` | Cadences for reactivation **rounds 1+** (0049) as an array of arrays of minutes, e.g. `'[[360,1080],[960]]'::jsonb` — each time the lead ghosts again the next (shorter, softer) round runs, and past the last one pursuit stops for good. `NULL` = platform default taper (`[[360,1080],[960]]`); `[]` = round 0 only (one ghost cycle, then stop). Round 0 always runs `follow_up_cadence`. See business-logic §4.3. |
| `ai_provider` / `ai_model` | `NULL` = platform default (`openai` / `gpt-5.6-luna`). Only override with reason — an override also opts the tenant out of the per-role reasoning effort unless the model accepts it. |

### What goes inside `prompt_overrides` (the jsonb blob)

This is the tenant's voice. Every key is optional; omit one and the platform default for
that section renders instead. Full precedence model and a diagram:
[`config-model.md`](config-model.md).

| Key | Effect |
| --- | --- |
| `identity` | Replaces the opening identity line. Where you disclose the AI nature, the role and the channels. |
| `offering` | Replaces the whole `# Servicios` section — so `services` stops being rendered (it still drives `calendars` lookups). Also the right home for commercial framing and objection answers: base-level, and a variant only loses them if it overrides this field. |
| `qualificationNotes` | Replaces the built-in `# Tu objetivo` / `# Flujo de calificación` block. **The conversational FLOW, and only the flow** — this is the field a campaign variant replaces wholesale, and it is also emptied on `closer` turns. Anything parked here is absent from both. |
| `houseRules` | Tenant-wide rules that outrank the flow (who we will/won't serve, what we never promise). Rendered after the flow, labelled as governing it. **A campaign variant cannot override this** — that is the entire point. Suppressed in demo mode. Put anything that must survive a campaign HERE, not in `qualificationNotes`. |
| `toolInstructions` | `{ "<toolId>": "<rule>" }` — a per-tool section. Merged **per key** by a variant, so base rules survive unless that exact tool is overridden. |
| `bookingEnabled` | `false` strips every booking instruction from the prompt (see business-logic §5a). Variant-overridable. |
| `confirmContactName` | Enables the deterministic post-turn name backstop. Read from **base** config by the handler, so a variant can never half-enable it. |

### Adapting a demo persona into a real tenant

Demo personas live in another tenant's `demo_prompt_overrides` and are written for a
**demo context**. Copying one into `prompt_overrides` verbatim ships three bugs:

1. **Control-keyword opener.** The demo's `qualificationNotes` usually starts with "if
   the last message is just `demo on` / a control word, don't comment on it…". Real
   leads never send that. Replace with a normal opening instruction.
2. **Borrowed calendar.** The demo books against the *host* tenant's calendar and
   service name ("Sesión de instalación"), often with "never mention this internal name
   to the lead". Rewrite `toolInstructions` **and** the AGENDAR paragraph to the real
   tenant's service name, and make that name a key in `calendars`.
3. **Stale "not confirmed" list.** The demo's `offering` lists facts it must not invent
   (hours, payment methods…). Anything you now configure for real must be **removed
   from that list**, or the agent will refuse to state a fact it actually has. Hours in
   particular are always rendered, so leaving "horarios de atención" in the do-not-state
   list makes the agent contradict its own prompt.

## 2. Install the GHL app

Open, logged into the client's subaccount:

```
https://thebotcrew-agents.floral-credit-be7e.workers.dev/oauth/ghl/install
```

Choose the location → approve. A token lands in `ghl_oauth_tokens` keyed by `tenant_id`.

Verify:
```sql
select t.ghl_location_id, o.expires_at > now() as valid, o.scope
from ghl_oauth_tokens o join tenants t on t.id = o.tenant_id
where t.ghl_location_id = '<locationId>';
```

**Scope drift is a real failure mode.** Tokens issued before a scope was added to
`SCOPES` in `ghl/oauth.ts` silently lack it and 401 at runtime — that is exactly how
every merged Facebook Instant-Form lead went unanswered on 2026-07-06. When scopes
change, every tenant must **re-authorize** through this same URL. Current set:
`conversations/message.readonly`, `conversations/message.write`, `conversations.readonly`,
`calendars/events.write`, `calendars.readonly`, `calendars/events.readonly`,
`contacts.readonly`, `contacts.write`.

> The two calendar **read** scopes were added 2026-07-22. Tenants installed before that
> date (The Bot Crew, happy Naty Nat, MADI Skin Care) lack both:
> - `calendars.readonly` — onboarding-only; its absence just means step 3 is manual.
> - `calendars/events.readonly` — **runtime**: without it `getAppointment` 401s and the bot
>   reports a stale time for any appointment moved or cancelled directly in the GHL UI.
>
> So re-authorizing an old tenant is worth it for the second one, not just for convenience.

## 3. Fill in the calendars

List the location's calendars (needs `calendars.readonly`):

```
GET https://services.leadconnectorhq.com/calendars/?locationId=<locationId>
Authorization: Bearer <access_token from ghl_oauth_tokens>
Version: 2021-04-15
```

Then map service name → calendar id:

```sql
update tenant_config
set calendars = '{"<service name>":"<ghl calendar id>"}'::jsonb
where tenant_id = '<tenant uuid>';
```

The key must match, character for character, the `serviceName` the prompt tells the
agent to pass.

### Then reconcile the calendar against `hours` — do not skip this

`hours` and the GHL calendar are two independent sources of truth, and the agent uses
**both**: it *states* `hours` in its prompt, but it *offers* whatever `/free-slots`
returns. When they disagree, the bot contradicts itself — promising Saturdays it can
never book, or offering 8 a.m. right after saying they open at 10.

Dump the real availability before going live:

```bash
curl -s -H "Authorization: Bearer <token>" -H "Version: 2021-04-15" \
  "https://services.leadconnectorhq.com/calendars/<calendarId>/free-slots?startDate=<nowMs>&endDate=<nowMs+7d>"
```

Check the first/last slot per weekday and which weekdays appear at all, then make
`hours` match — or have the client fix the calendar's availability in GHL. Slot strings
carry their offset (`2026-07-22T11:00:00-07:00`); if that offset doesn't match the
tenant's `timezone`, the timezone is wrong and every offered time will be shifted.

## 4. Test before going live

```sql
update tenant_config set test_contact_ids = array['<your GHL contactId>']
where tenant_id = '<tenant uuid>';
```

While `test_contact_ids` is non-empty the bot replies **only** to those contacts, on
**any** channel (it bypasses the channel gate). Inbound messages from everyone else are
still stored — only the reply is gated.

Watch it work:
```sql
select event_type, payload, created_at from bot_events
where client_id = '<client uuid>' order by created_at desc limit 20;
```

## 5. Go live

```sql
update tenant_config
set enabled_channels = array['whatsapp'],   -- 'whatsapp' | 'instagram' | 'facebook'
    test_contact_ids = null
where tenant_id = '<tenant uuid>';
```

Optional: `trigger_keywords` for ad-CTA flows — an **entry** gate, not a per-message
one. Once a conversation is activated (`conversations.bot_activated`) it flows without
the keyword.

### Recommended for every tenant: the pending-info queue (0050)

```sql
update tenant_config set pending_info_tag = 'dato-pendiente'
where tenant_id = '<tenant uuid>';
```

When a lead asks something the config doesn't answer, the bot says it will confirm with
the team and tags the contact with this (business-logic §6b). **Create the tag in GHL**
and make a smart list for it — it is *your* queue, not the client's: each hit is a hole
in the config you can close, and closing it is what stops the next lead from hitting it.
Keep it distinct from `awaiting_human_tag` (the client's booking queue) or the signal is
lost the moment the receptionist answers and clears the tag.

The lead stays parked (no automated nudges) until **both** tags are off the contact — so
this queue has to actually be worked. What's pending, ranked:

```sql
select metadata->>'topic' as tema, count(*), max(created_at) as ultima
from bot_events where event_type = 'pending_info'
group by 1 order by 2 desc;
```

`NULL` = the tenant doesn't use it: the bot still promises to confirm and still stops the
nudges, it just writes no tag — the promise is then only visible in `bot_events`.

---

### Recommended once the tenant has traffic: escalation + the info-gap report (0054)

Two columns and one jsonb, all NULL by default (off):

```sql
update tenant_config set
  pending_info_escalation_tag   = 'dato-sin-respuesta',  -- added when a pending_info aged out unanswered
  pending_info_escalation_hours = 24,                    -- NULL = 24
  info_gaps = '{"enabled": true, "min_candidates": 10, "max_days": 7, "min_for_time_run": 3}'
where tenant_id = '<tenant uuid>';
```

- The escalation tag needs the `contacts.write` scope (same as the other tags). Tell the
  client's team what the third tag means: *the bot promised to confirm something and
  nobody answered the lead in a day*.
- The report runs by itself (5-minute cron drains the queue, a run opens when the
  cadence says so). To force a tenant's FIRST report right after enabling it:
  `POST /internal/run-info-gaps` with the cron bearer, every 5 minutes until
  `runsFinished` is 1 — or just wait. Read it in a browser at
  `https://thebotcrew-agents.floral-credit-be7e.workers.dev/reports/info-gaps/<tenant uuid>?key=<report_key>`
  (HTML; add `&format=md` for the markdown; a `Authorization: Bearer` header also works for
  curl). The key is the tenant's own `tenant_config.report_key` (0055) — the DB generated
  it, nothing to set: `select report_key from tenant_config where tenant_id = '…'`. It can
  be handed to the client (it opens only their report). It travels in the URL so the page
  opens without tooling, which means it lands in browser history — rotate it with
  `update tenant_config set report_key = encode(gen_random_bytes(16), 'hex') where …`.
- Loading what the report proposes is a prompt change: edit the tenant row, mirror the
  fixture, add the golden case, run it red then green — same as any other prompt edit.
  Then mark the `info_gaps` row `closed` (or `dismissed` for noise) so the next report
  stops proposing it; a `closed` topic that keeps being asked is reported as a prompt bug.

See docs/business-logic.md §8.

## 6. Give the tenant its own AI key

**No longer optional for The Bot Crew's current offer** (2026-07-31): the commercial model
is that Leo covers his service, his time and every tool, while the client covers **only the
AI consumption, in their own account, at cost** — because that spend scales with their
message volume and can't be promised blind. That promise is only true if the client's
account is the one being billed, so a new client gets their own key as part of onboarding,
not as an upgrade. Skipping it means Leo silently eats their AI spend and the bot's pricing
answer becomes a lie.

(For a tenant on some other arrangement it remains optional — skip it and the tenant runs
on the platform key; token accounting in `llm_usage` still works either way, tagged
`key_source='platform'`.)

**This is the one onboarding step that is NOT just a DB row**, because key material
never goes in the database.

1. In the OpenAI dashboard create a **project** for the client (a project, not just a
   loose key — that's what gives you cost breakdown *and* a per-project spend limit),
   and issue a key inside it.
2. Store it as a Worker secret named `OPENAI_API_KEY__<SLUG>` (or
   `ANTHROPIC_API_KEY__<SLUG>`). The slug is uppercase A–Z0–9, other characters become `_`:

   ```bash
   pnpm --filter @thebotcrew/workers exec wrangler secret put OPENAI_API_KEY__MADI
   ```

3. Point the tenant at it — the DB stores the **slug only**, never the key:

   ```sql
   update tenant_config set ai_key_ref = 'MADI' where tenant_id = '<tenant uuid>';
   ```

**Order matters:** set the secret *before* the `ai_key_ref`. A ref with no matching
secret does not break the tenant — `resolveAiApiKey` falls back to the platform key so
the bot keeps answering — but every turn in between is billed to the platform key and
logs a `bot_events` row:

```sql
select created_at, metadata from bot_events
where event_type = 'ai_key_fallback' order by created_at desc limit 20;
```

Verify the key is actually being used (should read `MADI`, not `platform`):

```sql
select key_source, count(*), sum(input_tokens + output_tokens) as tokens
from llm_usage u join conversations c on c.id = u.conversation_id
where u.client_id = '<client uuid>' and u.created_at > now() - interval '1 day'
group by key_source;
```

---

## 7. Meta CAPI — send lead-quality signals back to Meta (0048)

Optional, per tenant. For a client running **click-to-WhatsApp (CTWA) ads**: without
this, Meta optimizes toward "anyone who messages" and the ads fill with bad leads.
With it, the platform reports back which conversations became real leads
(`LeadSubmitted` on first contact, `QualifiedLead` on booking by default), and the
campaigns can train on that. Full behavior: `docs/business-logic.md` § Meta CAPI.

Attribution is automatic: GHL stores the ad click id on the contact
(`attributionSource.ctwaClid`) and the Worker captures it on the first turn. Leads that
didn't come from a CTWA ad simply produce no events. **Events only flow for leads whose
first turn ran after `meta_capi` was configured** — the capture happens at turn time, so
there is no backfill for older conversations.

Needs three Meta assets from the account that runs the ads (theirs or ours — for a
client-owned Business Manager, ask for admin access to Events Manager or have them do
step 1 and send you the three values):

1. **Dataset + access token** — Events Manager → the ad account's dataset (create one
   if none) → Settings → Conversions API → **Generate access token**. Note the
   **dataset id** (the pixel id) and grab a **test event code** from the *Test events*
   tab while you're there.
2. **Page id** — the Facebook page the CTWA ads run from.
3. Store the token as a Worker secret (slug rules same as AI keys — this is the second
   onboarding step that is not just a DB row):

   ```bash
   pnpm --filter @thebotcrew/workers exec wrangler secret put META_CAPI_TOKEN__MADI
   ```

4. Point the tenant at it, **with the test code on** for verification:

   ```sql
   update tenant_config set meta_capi = '{
     "dataset_id": "<dataset id>",
     "page_id":    "<page id>",
     "token_ref":  "MADI",
     "test_event_code": "<TESTxxxx>"
   }' where tenant_id = '<tenant uuid>';
   ```

5. **Verify end-to-end**: click one of the live CTWA ads from a personal phone, send a
   message, let the bot answer. Within ~2 minutes a `LeadSubmitted` should appear in
   Events Manager → Test events, attributed to the ad. Check our side too:

   ```sql
   select kind, event_name, status, attempts, last_error from capi_events
   order by created_at desc limit 10;
   select created_at, event_type, metadata from bot_events
   where event_type in ('capi_event_sent','capi_error') order by created_at desc limit 10;
   ```

6. **Remove `test_event_code`** (set the jsonb without that key) — events now count
   for real ad optimization.

**Order matters, but it self-heals:** a `token_ref` with no secret does NOT lose
events — the queue parks them `pending` (one loud `capi_error` per tenant, stage
`missing_token_secret`) and sends as soon as the secret lands. There is deliberately
**no platform fallback token**: a Meta token belongs to one advertiser. Rows unsent
after 48h expire (`failed`, reason `expired`) because the click id's attribution value
decays in days anyway.

Per-tenant event tuning (all optional, in the same jsonb): rename an event or attach a
value, or disable a kind —

```jsonc
"events": {
  "lead_started": false,                                            // don't signal first contact
  "appointment_booked": { "name": "Purchase", "value": 350, "currency": "MXN" },
  "conversation_completed": { "name": "QualifiedLead" }             // off unless configured
}
```

Ads-side follow-through (the actual payoff, manual): once `QualifiedLead` events flow
for a couple of weeks, switch the CTWA campaigns from plain engagement to optimizing on
the dataset's qualified-lead events (or enable lead filtering) in Ads Manager.

---

## 8. Staff bookings — the appointment workflow webhook (0049 follow-up)

Our `appointments` store only sees what the **bot** books. For tenants where staff books
in the GHL calendar (every `bookingEnabled=false` tenant, and package rebookings
anywhere), those citas never reach the stats — unless the tenant has this workflow.

**One-time platform setup** (already done if `wrangler secret list` shows it):
`wrangler secret put GHL_WORKFLOW_SECRET` with a strong random value
(`openssl rand -hex 32`). The endpoint 401s (fails closed) while it is unset.

**Per-tenant setup, in the GHL sub-account** — create a workflow:

1. **Trigger:** `Customer Booked Appointment` (all calendars).
2. **Action:** `Webhook` →
   - Method `POST`, URL `<worker base>/webhooks/ghl/appointments`
   - Header: `Authorization` = `Bearer <the GHL_WORKFLOW_SECRET value>`
   - Body: **the default payload is enough** — the parser reads `location.id`, root
     `contact_id` (root `phone`/`email` as a search fallback) and
     `calendar.appointmentId`. The appointment object only rides along when the
     workflow's trigger is appointment-shaped, which step 1 guarantees.
   - Custom data (optional but recommended): key `action`, value `booked` — and on
     the status-change trigger variants, `cancelled` / `rescheduled`. Omitted =
     `booked`.

Notes that save debugging time:

- **Only the IDs are read.** The endpoint fetches startTime/title live from GHL
  (`getContactAppointments`) — the default payload's `calendar.startTime` is a
  wall-clock string in the calendar's timezone with NO offset, the exact class of
  the 5:15→10:15 booking bug. Everything else in the payload is ignored.
- **Bot bookings fire the workflow too** — that's fine: the endpoint dedups by
  appointment id + action (the bot's own row lands first).
- On `booked` the endpoint also cancels pending nudges, resets
  `reactivation_round`, **clears `awaiting_human` and removes the tenant's
  awaiting-human tag** from the contact — staff booking IS the "I've handled this"
  action, so the esperando-agenda loop closes itself (business-logic §4.3). Rows
  land with `source='ghl-workflow'`. It does **not** touch `pending_info_tag`: a
  booking doesn't answer a question we still owe her, so if that tag is still on, the
  ContactTagUpdate webhook parks her again on purpose (§6b).

---

## Costs per client — the pricing table

`llm_usage` records **tokens**, which we measure. Turning tokens into USD needs
**prices**, which we don't — so `model_pricing` ships empty and is filled by hand from
the provider's pricing page. A model with no price row reports `cost_usd = NULL` in
`llm_cost_monthly`: that is a *missing price*, never a free call. Nothing in this
system guesses a price.

### Adding a model

Prices are **USD per 1 million tokens**, exactly as the provider lists them.

```sql
insert into model_pricing (model, effective_from, input_usd_per_1m, output_usd_per_1m, cached_input_usd_per_1m)
values ('<model id>', '<ISO timestamp>', <input>, <output>, <cached>);
```

- `model` must match `tenant_config.ai_model` (and `DEFAULT_MODEL`) **character for
  character** — it's the join key. A typo silently yields NULL costs forever.
- `effective_from` should be **backdated** past the oldest usage you want costed.
  Rows older than the earliest price stay NULL.
- `cached_input_usd_per_1m` may be NULL; then cached tokens bill at the full input rate.

Currently loaded:

| model | effective_from | input | cached input | output |
| --- | --- | ---: | ---: | ---: |
| `gpt-5-mini` | 2026-01-01 | $0.25 | $0.025 | $2.00 |
| `gpt-5.6-luna` | 2026-08-11 | $0.20 | $0.02 | $1.20 |

### When a price changes — insert, don't update

**Never edit an existing row.** Insert a new one with a new `effective_from`:

```sql
insert into model_pricing (model, effective_from, input_usd_per_1m, output_usd_per_1m, cached_input_usd_per_1m)
values ('gpt-5-mini', '2026-09-01T00:00:00Z', 0.30, 2.50, 0.030);
```

The view prices each usage row at the rate in force **when the tokens were burned**, so
last month's reports don't silently change. `update` rewrites history — the one thing
that makes a cost report untrustworthy. (The primary key is `(model, effective_from)`,
so re-running the same insert is a conflict, not a duplicate.)

### Reading it

```sql
-- What each client cost this month
select client_name, model, call_kind, calls, input_tokens, output_tokens, cost_usd
from llm_cost_monthly
where month = date_trunc('month', now())
order by cost_usd desc nulls last;
```

`call_kind` splits the spend by what caused it: `front-desk` (the agent turn — the bulk),
`reactivation` (follow-ups), `classify` and `extract-name` (the cheap per-turn helpers).
If `classify` ever rivals `front-desk`, that's the signal to stop running it every turn.

To go per-conversation (cost per lead, cost per booked appointment), join `llm_usage`
straight to `conversations` — the view aggregates by month, `llm_usage` doesn't.

---

## Live tenants

| Client | `ghl_location_id` | tenant_id | Channels |
| --- | --- | --- | --- |
Verified against the DB on **2026-07-31**. When in doubt the DB is the truth — this table
has been stale before; re-run the query under it rather than trusting the row.

| Client | `ghl_location_id` | tenant_id | Channels |
| --- | --- | --- | --- |
| The Bot Crew | `wRMDr6h3anwYpM64XAUe` | `04385692-5c0d-436e-af77-4b1aa3fcc223` | whatsapp, instagram, facebook — **live**, gated by `trigger_keywords`. The only tenant with `demo_sessions_enabled` and with campaign variants: `keyword_variants` maps the demo ad CTAs (`quiero mi demo`, `mi propia IA`) to the `demo-funnel` variant, whose `qualificationNotes` is the demo route; base = the route to the 20-min call. Note `completé el formulario` is a `trigger_keywords` entry only — those leads are answered but take the base route. `houseRules` carries the fit filter, the conversation principles, the opening protocol and the absolute rules; `offering` carries the commercial framing and the objection answers. See [`config-model.md`](config-model.md) § Where to put a given piece of text. |
| happy Naty Nat | `X8zdJcQaVckHuF3W4grr` | `ceb2b145-e644-432e-b48d-3f92ba4a49bf` | facebook, but **test mode** — `test_contact_ids` non-empty outranks the channel gate, so only that one contact gets replies. |
| MADI Skin Care | `lIpNJhsKoGK8fPuDHeIn` | `19cf934b-2e36-4f4b-aa77-d3287e8d38fb` | whatsapp — **live, on purpose** (confirmed by Leo 2026-07-31; this doc had said "test mode, Leo only", which was stale — `test_contact_ids` is NULL, so every WhatsApp lead is answered). **No bot booking** (`bookingEnabled: false`, `calendars` cleared; see business-logic §5a). Own AI key (`ai_key_ref='MADI'`), `booking_horizon_days=7`. Original calendar id, if booking is ever restored: `fW2lw3VcAoa9Ns6jwaII` |
| Cliente Demo | `loc_demo_0001` | `73e8d3c3-0fdb-44e4-9e1a-3995c5d73bf4` | local dev seed |

`clients` also holds **Médica Center Fem** (6.5k conversations, last bot reply 2026-06-05):
legacy n8n-era data with **no `tenants`/`tenant_config` row**, so the platform never routes
to it. Don't mistake its volume for a live tenant.

```sql
-- the truth, any time this table looks doubtful
select tc.business_name, tc.enabled_channels, tc.test_contact_ids, tc.trigger_keywords,
       tc.ai_key_ref, tc.prompt_overrides ? 'houseRules' as house_rules, t.ghl_location_id
from tenant_config tc join tenants t on t.id = tc.tenant_id order by tc.business_name;
```
