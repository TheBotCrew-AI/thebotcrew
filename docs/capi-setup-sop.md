# SOP — Turn on Meta CAPI for a client (Messenger + Instagram + WhatsApp)

> **Purpose:** send lead-quality signals from the bot back to the client's Meta ads, so
> click-to-message campaigns stop optimizing for "anyone who messages".
> **Time:** ~45 min the first time per client, mostly clicking in Meta. No deploy.
> **You need:** admin on the client's Meta Business portfolio (or the client on a call),
> the Supabase MCP / SQL access, and `wrangler` for one secret.
>
> This SOP exists because The Bot Crew's own setup (2026-08-26/27) took an evening and
> eight Meta rejections. Every step below is there because skipping it cost us a retry.
> Background on *why* the feature works the way it does: [`business-logic.md` §6a](business-logic.md).
> Rollout history: [`meta-capi-rollout.md`](meta-capi-rollout.md).

---

## 0. The picture you're building

```
  Meta side (client's Business portfolio)          Our side (tenant_config.meta_capi)
  ─────────────────────────────────────────         ─────────────────────────────────────
  Facebook Page ──── dataset A ─┐                   page_id, dataset_id = A
  Instagram acct ─── dataset A  ├─ one system user  instagram_business_account_id
  WhatsApp (WABA) ── dataset B ─┘  = one token      whatsapp_business_account_id,
                                                    datasets.whatsapp = B
                                                    token_ref → META_CAPI_TOKEN__<SLUG>
```

Three facts that explain most of the pain:

1. **Meta binds one dataset per asset.** The Page and the IG account usually share the
   dataset you created; the WhatsApp account gets **its own** dataset, created by Meta
   when you connect it. Our config routes each channel to its dataset.
2. **The token is only as good as the assets its system user holds.** Every Page,
   WhatsApp account and dataset must be *assigned* to the system user that owns the
   token. Scopes are frozen when the token is minted — assigning assets later works,
   asking for new scopes does not (and needs a Meta app; don't).
3. **Each channel matches on a different key**, and GHL exposes all three on the contact:
   `ctwa_clid` (WhatsApp, ad clicks only), PSID (Messenger, everyone), IGSID (Instagram,
   everyone). The bot captures the key on a conversation's **first turn only**.

---

## 1. Collect the IDs (10 min)

| # | What | Where | Sanity check |
|---|---|---|---|
| 1 | **Facebook Page ID** | Business Settings → Accounts → Pages → the page → ID | Open `facebook.com/<id>`: it must render the **Page**. If it redirects to Instagram, that's the IG account's id, not the Page (this bit us: `752…` was IG, the Page was `780…`). |
| 2 | **Instagram business account ID** | Business Settings → Accounts → Instagram accounts → ID | 17 digits starting with `178…` |
| 3 | **WhatsApp Business Account ID (WABA)** | WhatsApp Manager → Account tools → Business settings, or Business Settings → Accounts → WhatsApp accounts | Must be the WABA whose number is connected to GHL |
| 4 | **Dataset ID** (the page's) | Events Manager → Data sources → the dataset (create one if none) → Settings | Same number as the pixel id |
| 5 | **The channels the client actually runs ads on** | Ask. | Decides which wizard runs and which verifications you do |

Write them down; you'll paste them into one SQL statement in §3.

---

## 2. Meta side (20–30 min)

### 2.1 Connect each asset to the dataset — the Messaging wizard

Events Manager → the dataset → **Connect data** (or *Add data source*) → **Messaging** →
choose the **channel** → choose the asset → Next through the event/parameter screens.

Run it once per channel the client uses:

| Channel in the wizard | Asset to pick | What happens |
|---|---|---|
| **Messenger** | the Facebook **Page** (check the id — not the IG lookalike) | attaches to this dataset |
| **Instagram** | the IG business account | attaches to this dataset |
| **WhatsApp** | the WABA / phone number GHL uses | Meta **creates a new dataset** for the WABA. Note its id → `datasets.whatsapp` |

On the wizard's event/parameter screens pick exactly what we send:

- **Events:** `LeadSubmitted` (and `Purchase` only if this tenant will map booking → Purchase).
  Ignore that `QualifiedLead` isn't listed; the API accepts it.
- **Parameters:** **Event ID** and **Phone**. Nothing else (email, names, city, LTV… we
  never send them and unchecked-but-sent is fine, checked-but-never-sent hurts match quality).

### 2.2 The token (once per client)

Events Manager → the page dataset → Settings → **Conversions API** → *Generate access
token*. Copy it somewhere safe for the next 5 minutes; it goes into a Worker secret (§3.1)
and nowhere else — never into chat, tickets or the DB.

That creates (or reuses) a system user, usually named **Conversions API System User**.

### 2.3 Assign every asset to that system user

Business Settings → Users → **System users** → *Conversions API System User* → **Assign
assets**:

- **Pages** → the Page → full control
- **Instagram accounts** → the IG account
- **WhatsApp accounts** → the WABA
- **Datasets** (under Data sources) → the page dataset **and** the WABA dataset

Miss one and the matching channel fails with a permission error (§5). The token itself
needs no regeneration after assigning.

### 2.4 Test codes (one per dataset)

Events Manager → each dataset → **Test events** tab → note the code.

- Page dataset → covers Messenger + Instagram → `test_event_code`
- WABA dataset → covers WhatsApp → `test_event_codes.whatsapp`

(The dataset may also show a *web* test code on another tab — that one labels messaging
events under a different bucket and is not the one you want.)

---

## 3. Our side (5 min)

### 3.1 The secret

```bash
pnpm --filter @thebotcrew/workers exec wrangler secret put META_CAPI_TOKEN__<SLUG>
```

`<SLUG>` is what you'll put in `token_ref` — uppercase, letters/digits/underscore
(`MADI`, `BOTCREW`). Paste the token when prompted.

### 3.2 The config row

```sql
update tenant_config set meta_capi = '{
  "dataset_id":                    "<page dataset id>",
  "page_id":                       "<facebook page id>",
  "token_ref":                     "<SLUG>",
  "instagram_business_account_id": "<ig account id>",
  "whatsapp_business_account_id":  "<waba id>",
  "datasets":         { "whatsapp": "<waba dataset id>" },
  "test_event_code":  "<page dataset test code>",
  "test_event_codes": { "whatsapp": "<waba dataset test code>" }
}'::jsonb
where tenant_id = '<tenant uuid>';
```

Drop the keys for channels the client doesn't use. Optional per-tenant event tuning
(`events`) is documented in [`onboarding.md` §7](onboarding.md); the defaults —
`lead_started → LeadSubmitted`, `appointment_booked → QualifiedLead` — are right for a
service business.

No deploy. The 1-minute cron reads this row fresh on every drain.

---

## 4. Verify each channel (15 min)

### The first-turn rule (read this before testing)

The key is captured **only on a conversation's first turn**, before the bot has ever
replied. A test from a phone/account GHL already knows lands on the old thread and
captures **nothing** — you'll think the pipeline is broken. Before each test:
**delete the test contact in GHL** so the click creates a fresh contact + conversation.

### How to trigger each channel

| Channel | Trigger | Why |
|---|---|---|
| Messenger | click a live click-to-Messenger ad from a personal profile → message → let the bot reply | organic works too (every contact has a PSID), but a click proves attribution |
| Instagram | DM the business account from a personal IG account → let the bot reply | organic is enough — every IG contact has an IGSID |
| WhatsApp | click a live **click-to-WhatsApp** ad from a phone → message → let the bot reply | the key is the ad click id: organic WhatsApp can never produce an event |

If the client's ad set targets all three apps, Meta chooses the destination per person —
to force WhatsApp for the test, use (or temporarily duplicate) an ad set with **only
WhatsApp** ticked. The WhatsApp option is greyed out until the number is linked to the
Page (Page → Settings → WhatsApp).

### What to check, in order

```sql
-- 1. capture: the new conversation has the key and the ad
select channel, capi_match_key, attribution->>'adId' as ad_id, created_at
from conversations where ghl_conversation_id = '<from GHL>';

-- 2. queue → send: status must reach 'sent' within a minute
select event_id, payload->>'messaging_channel' as ch, status, attempts, last_error, sent_at
from capi_events order by created_at desc limit 5;

-- 3. Meta's own answer: eventsReceived must be 1, no messages[]
select created_at, metadata from bot_events
where event_type in ('capi_event_sent','capi_error') order by created_at desc limit 5;
```

Then Events Manager → that channel's dataset → **Test events** → filter by the test
code → the `LeadSubmitted` is there.

**Re-sending without a new click:** a rejected row is terminal (`failed`). After fixing
the Meta-side cause, re-queue it — the key stays valid for days:

```sql
update capi_events set status='pending', attempts=0, last_error=null
where event_id = '<ghl_conversation_id>:lead_started';
```

If Meta already *accepted* the same `event_id` once (e.g. re-testing under a new test
code), give it a fresh id or Meta's dedup swallows it:
`set event_id = event_id || '#retest-1'` in the same statement.

---

## 5. Troubleshooting — every error we've hit, with the fix

All of these arrive as a Graph **400** in `capi_events.last_error` and as a `capi_error`
row (`stage: rejected`) in `bot_events`. Match on the `error_subcode` / title.

| Error | Meaning | Fix |
|---|---|---|
| `2804131` *No Page Associated To Dataset* | the dataset has no asset attached for this channel | run the Messaging wizard for that channel (§2.1). **On WhatsApp** it means `page_id` was sent to the WABA dataset — a Worker older than `56460aa`; deploy |
| `2804065` *Mismatching Page and Dataset* | the wizard attached a different asset than `page_id` | check what the dataset lists as connected; re-run the wizard picking the real Page (see the IG-lookalike trap in §1) |
| `2804073` *Mismatching Page Id and Page Scoped User Id* | `page_id` isn't the Page GHL is connected to | fix `page_id`; verify with `facebook.com/<id>` |
| `2804066` *Invalid Event Type* | an event name that isn't in Meta's business-messaging set (`Schedule`, `Lead`, `Contact`…) | don't rename events to match the Ads Manager picker — it lists events the dataset has *received*, not what's valid |
| `2804079` *Missing IG Account ID* | Instagram payload lacks `ig_account_id` | config lacks `instagram_business_account_id` — or a Worker older than `fcf4395` |
| `2804132` *No WhatsApp Business Account Linked to This Dataset* | WhatsApp event sent to the page dataset | set `datasets.whatsapp` to the WABA's own dataset (§2.1) |
| `Object with ID '<dataset>' does not exist … missing permissions` | the token's system user doesn't hold that dataset | assign the dataset to the system user (§2.3) |
| `(#200) App does not have page_events permission` / `(#200) You do not have permission to access this field` | you called `/{page}/dataset` or `/{waba}/dataset` with the CAPI token | don't — the wizard does it without page scopes |
| `2xx` but `eventsReceived: 0` or `messages[]` present | Meta received but didn't count / warned | read `messages` in the `capi_event_sent` row; usually a user_data problem |
| `capi_error` stage `missing_token_secret` | no `META_CAPI_TOKEN__<SLUG>` secret | §3.1; rows stay pending and send once the secret lands |
| `capi_error` stage `config_missing` | `meta_capi` malformed (needs `dataset_id`, `page_id`, `token_ref`) | fix the row |
| Sent, `eventsReceived: 1`, but not in Test events | wrong test code for that dataset, or the UI needs a refresh / a few minutes | check §2.4; the event *was* counted |

### Things that look like fixes and aren't

- **Creating a Meta app** to get page scopes. Not needed; the Events Manager wizard links
  assets without any of that. A partner-app model is a real project (App Review) — only
  worth it at 10+ clients.
- **Picking `Schedule` for bookings.** Website-only. `QualifiedLead` is the right event and
  the API accepts it even if the ads UI doesn't list it yet.
- **Sending `page_id` "for good measure" on WhatsApp.** It triggers the page check on a
  dataset that has no page.
- **One dataset for everything.** Not how messaging works; per-asset datasets cost
  nothing in optimization (ad sets optimize on an event name across their destinations).

---

## 6. Go live

1. Once each channel shows in Test events: remove the test codes —
   ```sql
   update tenant_config set meta_capi = (meta_capi - 'test_event_code') - 'test_event_codes'
   where tenant_id = '<tenant uuid>';
   ```
   From then on events count for real.
2. Leave it alone for ~2 weeks (Meta wants volume — ~50 events/week to learn).
3. Ads Manager, per ad set: conversion location **Messaging apps**, performance goal
   **Maximize number of conversions**, event **`LeadSubmitted`** (later `QualifiedLead`
   once bookings flow). *This* is the step that filters the bad leads; the events alone
   only inform.
4. Tell the client which events they'll see in Events Manager: `LeadSubmitted` on first
   contact, `QualifiedLead` when the bot books. Nothing is sent for disqualified leads —
   the absence is the signal.

---

## 7. Reference

**Full `meta_capi` shape**

```jsonc
{
  "dataset_id": "…",                    // required — the page dataset
  "page_id": "…",                       // required — the Facebook Page
  "token_ref": "SLUG",                  // required — Worker secret META_CAPI_TOKEN__SLUG
  "instagram_business_account_id": "…", // required for Instagram events
  "whatsapp_business_account_id": "…",  // required for WhatsApp events
  "datasets":         { "whatsapp": "…", "messenger": "…", "instagram": "…" }, // per-channel overrides
  "test_event_code":  "TEST…",          // while verifying
  "test_event_codes": { "whatsapp": "TEST…" },
  "events": {                           // optional
    "lead_started": false,
    "appointment_booked": { "name": "Purchase", "value": 350, "currency": "MXN" },
    "conversation_completed": { "name": "QualifiedLead" }   // off unless set
  }
}
```

**What each channel sends** (`action_source=business_messaging`, `event_id = <conv>:<kind>`):

| channel | user_data |
|---|---|
| `whatsapp` | `ctwa_clid`, `whatsapp_business_account_id`, `ph` (sha256) |
| `messenger` | `page_scoped_user_id`, `page_id`, `ph` if any |
| `instagram` | `ig_sid`, `ig_account_id`, `ph` if any |

**Worked example — The Bot Crew (2026-08-27):** Page `780376008489108` + IG
`17841475598106121` on dataset `28711302635123183` (test `TEST96971`); WABA
`1629186164979352` on its own dataset `4439936336229922` (test `TEST43188`);
`token_ref: BOTCREW`.

**Monitoring:** `[cron] run-capi: {tried,sent,failed,skipped}` once a minute in the
Worker logs; `bot_events` `capi_error` for anything that went wrong; rows unsent after
48h expire on purpose (the click id's value decays in days).
