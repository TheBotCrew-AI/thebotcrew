# Meta CAPI rollout — status & handoff

> The per-tenant Meta Conversions API integration (migration 0048): what shipped, what
> was verified, and exactly what remains to turn it on for a tenant. Read this to pick
> the work up in a fresh session without re-deriving anything.
>
> Behavior spec: [`business-logic.md` §6a](business-logic.md). **Per-tenant setup:
> [`capi-setup-sop.md`](capi-setup-sop.md)** (the step-by-step, with the troubleshooting
> table distilled from this log). This file is the rollout log — the analogue of
> `durable-objects-migration.md` for this feature.

## Status (2026-08-26)

**Live in prod; first tenant armed.** Code, migration, deploy and monitoring were done and
verified 2026-08-02; the feature sat dormant (every `meta_capi` NULL, zero events) until
2026-08-26, when **The Bot Crew** (Leo's own CTWA ads) became the first configured tenant:
secret `META_CAPI_TOKEN__BOTCREW` + `meta_capi` row set **with `test_event_code` still on**.
Pending: the live-ad click test, then removing the test code. MADI is still NULL.
Turning a tenant on is config-only (one Worker secret + one DB row — no redeploy).

| Step | State | Evidence |
| --- | --- | --- |
| Migration 0048 on prod | ✅ applied 2026-08-02 | verified object-by-object: columns, `capi_events` (RLS on, 0 policies), 4 RPCs (anon/authenticated revoked), `bot_events` constraint includes `capi_event_sent`/`capi_error` |
| Code on `main` | ✅ commit `a69b740` | CI green (typecheck + `test:unit`), 580 unit tests + `supabase/tests/0048_meta_capi.test.sql` (10 cases) |
| Worker deployed | ✅ version `0e66459c` | direct deploy (feature dormant + no DO migration ⇒ gradual not needed) |
| Cron drain running in prod | ✅ | tailed live: `[cron] run-capi: {"tried":0,"sent":0,"failed":0,"skipped":0}` every minute |
| 0056 (Messenger/Instagram) on prod + Worker | ✅ 2026-08-26 | migration applied via Supabase MCP (column + comments verified), commit `3412d92`, Worker version `8aec238d`; 778 unit tests + `0056` DB test green |
| The Bot Crew — first event ACCEPTED by Meta | ✅ 2026-08-27 02:55 UTC | a real FB ad click → Messenger lead → `LeadSubmitted` on `messenger` (`page_id` 780376008489108 + PSID) → `capi_event_sent` with `TEST47597`. Took four Meta-side rejections to get there (below) |
| The Bot Crew — Instagram ACCEPTED | ✅ 2026-08-27 03:16 UTC | organic IG DM → `LeadSubmitted` on `instagram` (`ig_sid` + `ig_account_id`). First attempt was rejected `2804079` because the wire key is `ig_account_id`, not the doc's `instagram_business_account_id` — fixed in `fcf4395`, Worker `48894b1c` |
| The Bot Crew — WhatsApp ACCEPTED | ✅ 2026-08-27 14:34 UTC | real CTWA click → `LeadSubmitted` on `whatsapp` (`ctwa_clid` + `whatsapp_business_account_id`, no `page_id`) to the WABA's OWN dataset `4439936336229922`, `events_received: 1`, `TEST43188`. Three rejections first (gotchas 6–8) |
| Cron overlap fixed | ✅ `07c47a6`, Worker `fd65dcec` | the minute jobs ran on EVERY cron schedule; at :00/:05 two invocations drained the same rows → one CAPI event posted twice. Follow-ups were safe (0043 commit gate) |
| **The Bot Crew LIVE** | ✅ 2026-08-27 | both test codes removed; every FB/IG/WA lead now sends `LeadSubmitted` on first contact and `QualifiedLead` on a real booking. Ads-side switch (Messaging apps → Maximize conversions on `LeadSubmitted`) due ~**2026-09-10** once volume exists |
| MADI configured | ❌ | needs Meta-side assets from MADI's ad account (below) |

## Why this exists

Engagement click-to-WhatsApp (CTWA) ads optimize toward "anyone who messages" — Meta
never learns which conversations became real leads, so the ads fill with bad ones. This
feature reports conversion signals back to each tenant's own Meta dataset so campaigns
can train on lead *quality*.

## The load-bearing fact (verified live — do not re-research)

Meta attributes a CTWA conversion **only** via the click id `ctwa_clid`. GHL **drops it
from webhooks** (open feature request on their ideas board, no ETA) but **stores it on
the contact record**:

```
GET /contacts/{id} → contact.attributionSource = {
  sessionSource: 'Paid Social', medium: 'whatsapp',
  ctwaClid: 'AfjMi93Y…', adId: '120250989588970351',
  adName: 'Chatea con nosotros', url: 'https://fb.me/…'
}
```

Verified 2026-08-01 against live MADI ad lead `Jf6IYFBWV264HktCntR8` (plus a duplicate
`lastAttributionSource`). This is why the whole integration is pure code-side — no
per-tenant GHL workflow relay was needed (that fallback was designed but cut from v1;
if a future tenant's contacts ever lack attribution, the relay design is in the
planning notes: a `POST /webhooks/ghl/attribution` route fed by a GHL workflow custom
webhook).

## Architecture in one paragraph

The turn-start contact fetch (the same one that captures merge keys, so it only runs
until the bot first speaks) extracts `ctwaClid` and persists it **first-touch sticky**
on `conversations` (`ctwa_clid` + raw `attribution` jsonb with adId/adName). Hook
points enqueue internal event kinds into the `capi_events` queue — idempotent, one
event per conversation per kind (`event_id = <ghl_conversation_id>:<kind>`, which is
also Meta's dedup id). The 1-minute cron (`runPendingCapiEvents`, also exposed as
bearer-secured `POST /internal/run-capi`) drains the queue to
`graph.facebook.com/v23.0/{dataset_id}/events` with `action_source=business_messaging`,
`messaging_channel=whatsapp`, `user_data={ctwa_clid (never hashed), page_id,
ph (SHA-256 E.164)}`. Token and `test_event_code` are read fresh from `tenant_config`
on every drain, so a rotation needs no re-enqueue.

### File map

| Piece | File |
| --- | --- |
| Pure config/payload (parse, secret-name, defaults, hashing) | `workers/src/meta/capi-config.ts` |
| Enqueue helpers + the Graph POST | `workers/src/meta/capi.ts` |
| Cron drain | `workers/src/worker/capi-runner.ts` |
| Capture hook | `webhook-handler.ts` — inside the turn-start `if (contact)` block (`extractCapiIdentity(parsed.channel, …)`) |
| Booking hook | `book-appointment.ts` — after the `lead_qualified` logEvent, real path only |
| Status hooks (`completed`) | `update-conversation-status.ts` (post-`applied` check) + the classifier branch in `webhook-handler.ts` |
| Queue + RPCs + columns | `supabase/migrations/0048_meta_capi.sql`; per-channel key `0056_capi_messaging_channels.sql` |
| DB tests | `supabase/tests/0048_meta_capi.test.sql`, `0056_capi_messaging_channels.test.sql` |

### Event kinds → Meta events (per-tenant overridable via `meta_capi.events`)

| kind | fires | default |
| --- | --- | --- |
| `lead_started` | first turn of a lead with a captured click id | `LeadSubmitted`, ON |
| `appointment_booked` | real booking success (never demo/simulated) | `QualifiedLead`, ON |
| `conversation_completed` | status → `completed`, applied (tool or classifier) | **OFF** unless configured |

### Decisions locked (with the why — don't relitigate casually)

- **Booking → `QualifiedLead`, not `Purchase`.** For service SMBs a booking is a
  qualified lead; QualifiedLead is what Meta's CTWA lead filtering trains on.
  `{"name":"Purchase","value":…,"currency":…}` is a per-tenant override.
- **`lead_disqualified` is never sent.** Meta's business-messaging event set has no
  negative event; the *absence* of QualifiedLead is the signal.
- **No platform fallback token** (opposite of `ai_key_fallback`, deliberately): a Meta
  token belongs to one advertiser; a fallback would write conversions into another
  advertiser's dataset. A missing `META_CAPI_TOKEN__<SLUG>` secret parks rows
  `pending` (one loud `capi_error`, stage `missing_token_secret`, attempts NOT
  consumed) and self-heals when the secret lands.
- **48h expiry** on unsent rows — the click id's attribution value decays in days.
- **4xx = terminal, 5xx/network = retry ×3** (mirrors delivery-retry's cap).
- **Demo/roleplay never signals** (same family as the other demo no-side-effects guards).
- **Messenger + Instagram since 0056 (2026-08-26).** v1 was WhatsApp-only because the
  click id was the one key GHL was known to expose; the same probe on The Bot Crew's own
  contacts found `attributionSource.pSid` (Facebook) and `attributionSource.igSid`
  (Instagram), so the capture became per-channel (`conversations.capi_match_key`), the
  `messaging_channel` is frozen in the queue payload, and `meta_capi` gained
  `whatsapp_business_account_id` / `instagram_business_account_id`. FB/IG leads all
  carry a key → those channels signal every lead and Meta attributes (pixel semantics).

## Meta-side gotchas — learned the hard way on The Bot Crew (2026-08-27)

Every one of these came back as a Graph 400 with a `2804xxx` subcode, visible in
`bot_events.capi_error` (`stage: rejected`). In the order we hit them:

1. **`2804131` "No Page Associated To Dataset".** A dataset created in Events Manager is a
   website dataset until an asset is attached. For business messaging the dataset must be
   linked to the Page / WABA / IG account: Events Manager → dataset → *Connect data →
   Messaging* → pick the channel → pick the asset. (The API route, `POST /{page_id}/dataset`,
   needs a token with `page_events`, which the Events Manager-minted CAPI token does not
   carry and cannot be given — scopes are frozen at mint; page scopes need a Meta *app*.
   Not worth it: the wizard does the same thing.)
2. **`2804065` "Mismatching Page and Dataset"** after the wizard: the wrong asset was
   attached. In the Messaging wizard the Instagram account shows up looking like a page
   (ours: "yourbotcrew", id `752042537985371` — `facebook.com/<id>` 301s to Instagram).
   Choose the channel **Messenger** explicitly and attach the actual Facebook Page.
3. **`2804073` "Mismatching Page Id And Page Scoped User Id"**: the PSID GHL gives us is
   scoped to the Page GHL is connected to. If `meta_capi.page_id` names anything else the
   pair is refused. Resolve the page id from `facebook.com/<id>` (a Page renders; an IG id
   redirects; a business-portfolio id 404s) — not from a Business Settings screenshot.
4. **`2804066` "Invalid Event Type"** for `Schedule`: website standard events (Lead,
   Schedule, Contact, …) are NOT valid with `action_source=business_messaging` — Meta's
   own message says "such as 'Purchase' or 'LeadSubmitted'". Our allow-list is right;
   don't rename events to match the Ads Manager picker, which only lists events the
   dataset has already *received* (a pixel-fed dataset shows pixel events).

5. **`2804079` "Missing IG Account ID parameter"**: the Instagram account id travels as
   **`ig_account_id`**, not `instagram_business_account_id` as Meta's onboarding example
   shows. Expect the WhatsApp one to be similarly mis-documented; the first CTWA send will
   name the real key.

6. **`2804132` "No WhatsApp Business Account Linked to This Dataset"**: connecting the WABA
   in the wizard gives it a dataset **of its own** (Meta: one dataset per asset —
   Page `2871…`, WABA `4439…`). Route the channel with `meta_capi.datasets.whatsapp`.
7. **Graph "Object with ID '<waba dataset>' does not exist… missing permissions"**: the new
   dataset must be **assigned to the token's system user** (Business Settings → System users
   → Assign assets → Datasets), exactly like the Page was.
8. **`2804131` again, on the WABA dataset**: a WhatsApp event must NOT carry `page_id` — the
   WABA dataset has no Page and the pair check fails. Payload is `ctwa_clid` +
   `whatsapp_business_account_id` only (Meta's doc example was right on this one).

Wizard picks that matched what we send: events **LeadSubmitted** (+ Purchase if the tenant
maps booking to it); parameters **Event ID** and **Phone** only. Test codes are **per
dataset**: `TEST96971` on the page dataset (Messenger + Instagram), `TEST43188` on the
WABA dataset — `meta_capi.test_event_codes.<channel>` carries the second one. The web
tab's `TEST47597` files messaging events under a different label.

## What remains — per-tenant activation (the only human-in-the-loop part)

For each tenant running CTWA ads (MADI first; The Bot Crew's own ads next):

1. **Meta side** (the ad account's Events Manager — Leo's own BM or the client's):
   dataset → Settings → Conversions API → *Generate access token*; note **dataset id**
   + the FB **page id** running the ads; grab a **test event code** from Test events.
2. `pnpm --filter @thebotcrew/workers exec wrangler secret put META_CAPI_TOKEN__MADI`
3. ```sql
   update tenant_config set meta_capi = '{
     "dataset_id": "<id>", "page_id": "<id>", "token_ref": "MADI",
     "test_event_code": "<TESTxxxx>"
   }' where tenant_id = '19cf934b-2e36-4f4b-aa77-d3287e8d38fb';  -- MADI
   ```
4. **Verify:** click a live ad from a personal phone, message, let the bot reply →
   `LeadSubmitted` in Events Manager → Test events within ~2 min. Our side:
   ```sql
   select kind, event_name, status, attempts, last_error from capi_events order by created_at desc limit 10;
   select created_at, event_type, metadata from bot_events
   where event_type in ('capi_event_sent','capi_error') order by created_at desc limit 10;
   ```
5. **Remove `test_event_code`** from the jsonb.
6. **The payoff (Ads Manager, ~2 weeks of QualifiedLead volume later):** switch the
   CTWA campaigns to optimize on the dataset's qualified-lead events / enable lead
   filtering. Without this the events only *inform*; the objective change is what
   filters the bad leads.

## Expectations & monitoring

- **No backfill:** capture happens at turn time — only leads whose first turns run
  after `meta_capi` is set produce events.
- Watchdogs: `bot_events` `capi_error` (stages: `missing_token_secret`,
  `config_missing`, `rejected`, `retries_exhausted`, `expired`) and the per-minute
  `[cron] run-capi` log line. A healthy idle tenant shows `tried:0`.
- Future reporting idea (not built): `conversations.attribution` carries adId/adName —
  joinable against `bot_events`/`appointments` for a per-ad lead-quality report.
