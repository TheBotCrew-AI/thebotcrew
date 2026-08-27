# Meta CAPI rollout — status & handoff

> The per-tenant Meta Conversions API integration (migration 0048): what shipped, what
> was verified, and exactly what remains to turn it on for a tenant. Read this to pick
> the work up in a fresh session without re-deriving anything.
>
> Behavior spec: [`business-logic.md` §6a](business-logic.md). Per-tenant setup
> procedure: [`onboarding.md` §7](onboarding.md). This file is the rollout log — the
> analogue of `durable-objects-migration.md` for this feature.

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
| The Bot Crew configured | 🟡 2026-08-26, test code ON | `token_ref: BOTCREW`, secret present; awaiting the live-ad click → Test events check, then drop `test_event_code` |
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
