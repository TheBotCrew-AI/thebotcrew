# Future Upgrade — Turn/Follow-up Durability via Durable Objects

> **Status: DONE — Phase 1 (2026-07-01) + Phase 3 cleanup (2026-07-03).**
> `DO_TURNS=*` — every tenant runs turns through the per-conversation Durable Object
> (durable Alarm debounce + serialized execution). **Phase 3 shipped (migration 0030):** the
> reconciliation cron, the `reconcile_claimed_at` claim, and their RPC/column were deleted after
> monitoring confirmed the DO handles 100% of turns (`turn_scheduled` ≈ front-desk turns, no
> recovery re-runs). The legacy `waitUntil` fall-through + `DO_TURNS` flag stay as a cheap
> rollback belt. **Only the optional Phase 2 (retire the follow-up polling cron) remains — defer
> indefinitely unless the cron becomes a problem.** The turn-durability goal is fully met.
>
> **KEY INSIGHT (changes the remaining plan):** Phase 1 *already* closed the follow-up
> durability gap — `scheduleFollowUp` is called inside `runAgentTurn`, which now runs inside the
> durable DO `alarm()`, so the follow-up row is written durably. The follow-up **send** is still
> the 1-min cron, which is perfectly adequate (follow-ups fire on hours/days). So **Phase 2
> (retire the follow-up cron → DO alarms) is now optional cleanup, not a durability fix** — and
> it carries real risk (touches every tenant's follow-up delivery; needs single-alarm
> multiplexing turn-vs-follow-up). **Recommended next when resuming: skip straight to Phase 3
> (delete the reconciliation/claim patches after a monitoring window); do Phase 2 last, or not
> at all.** Owner: Leo. Resume point + revised route at §7.

---

## 1. Why this exists (the root cause)

Today a turn is processed in a `waitUntil` with a `setTimeout` debounce (see
`worker/webhook-handler.ts`). That execution context is **ephemeral by design**: Cloudflare
can evict the isolate at any moment, and any in-flight work — generate → send → schedule
follow-up — is dropped **silently, with no trace**.

Every bug in the "double-message / missing-follow-up" saga traces back to the same two
missing properties: **per-conversation serialization** and **durable execution**. We've been
compensating with patches:

| Symptom | Patch (current) | Root cause |
|---|---|---|
| Double-send via inline retry | Fix A: no retry after 2xx (`sendWithRetry`) | non-idempotent send + ephemeral run |
| Echo mislabeled as human takeover | Fix B: content echo guard (`isRecentBotEcho`) | un-captured send id |
| Debounce vs reconciliation double-run | claim (`claimTurnForProcessing` + `reconcile_claimed_at`) | no serialization |
| Dropped turn (no reply) | reconciliation cron (`worker/reconciliation.ts`) | ephemeral `waitUntil`+`setTimeout` |
| Dropped follow-up scheduling | *(none — deliberately deferred to this doc)* | ephemeral run evicted post-send |

This is **patch-on-patch**. The right fix is architectural: move turn + follow-up processing
onto a durable, per-conversation primitive.

## 2. Target architecture — Durable Objects + Alarms

One **Durable Object** class, `ConversationDO`, addressed by conversation id (one instance per
conversation). Because a DO runs **single-threaded per instance**, all processing for a
conversation is **serialized** — the entire double-run / race class disappears by construction.

- **Inbound**: the webhook still verifies the signature, resolves the tenant, and persists the
  inbound message (unchanged). It then hands the message to the conversation's DO
  (`stub.fetch`/RPC) and returns 200 immediately.
- **Debounce**: the DO buffers rapid inbound messages and sets a **DO Alarm** ~15s out. The
  Alarm is **durable** — it survives eviction/restart and is guaranteed to eventually fire.
  This replaces the fragile `setTimeout`-in-`waitUntil`.
- **Turn**: on the debounce alarm the DO runs generate → send → persist reply → schedule the
  follow-up alarm. Human-takeover/suppression is re-checked inside the DO before send (as now).
- **Follow-ups**: the DO sets its **next follow-up as an Alarm** (quiet-hours clamp applied to
  the alarm time). On fire it sends the reactivation and sets the next alarm, or stops (freno).
  No per-minute polling cron needed.

## 3. What gets DELETED / simplified (the payoff)

The point of this migration is to **remove** patches, not add another:

- `worker/reconciliation.ts` + `app_load_unanswered_turns` RPC + `reconcile_claimed_at` column
  + `claimTurnForProcessing` — durability now comes from the guaranteed Alarm.
- The `setTimeout` debounce inside `waitUntil`.
- The follow-up **scheduler plumbing only**: the per-minute cron trigger for
  `worker/followup-runner.ts` + the `app_load_due_follow_ups` DB polling — replaced by
  per-conversation Alarms fired at the exact time. **The follow-up business logic is NOT
  touched** — tiers/cadence, the angle pool + non-repeating cursor, quiet hours, the freno, and
  the reactivation agent all stay exactly as they are (see business-logic.md §4). We're only
  swapping "a cron that polls every minute for due rows" for "a durable alarm set to the exact
  time"; same behavior, better mechanism (precise, per-conversation, survives eviction).
- Fix #1 (claim) and the reconciliation double-run concern — gone (serialized).
- Fix A (no-retry-after-2xx) can stay as-is (it's about GHL non-idempotency, still valid) but
  the *concurrency* reason for double-sends is gone.
- Fix B (`isRecentBotEcho`) becomes largely redundant (with serialization + reliable id capture
  the echo is matchable by id again) but is harmless to keep as a belt.

**Net:** fewer moving parts, correct-by-construction, and the "missing follow-up" gap closes
without a new sweep.

## 4. Prerequisites & cost

- **Workers Paid plan (~$5/mo)** — Durable Objects (and Queues/Workflows) require it. Crons
  work on free, which is why the current patches are cron-based.
- `wrangler.jsonc`: add a Durable Object **binding** + a **migration** entry (DO class names are
  sticky — the migration is a one-time `new_sqlite_classes`/`new_classes` declaration).
- No new external service; DO is native Cloudflare.

## 5. Alternatives considered (and why DO wins)

- **Cloudflare Queues** — at-least-once delivery + automatic retries. Lighter to adopt, but does
  **not** serialize per-conversation cleanly, so the race class would still need care. Good
  durability, weaker on ordering/coalescing.
- **Cloudflare Workflows** — durable multi-step execution (each step checkpointed/retried).
  Great for the turn *pipeline*, but the debounce/coalescing of a message burst is awkward to
  express. Worth revisiting for the turn steps specifically.
- **Durable Objects + Alarms** — the only one that gives **both** serialization (kills the race
  class) **and** durable timers (kills the drop class) in one primitive, and lets us *delete*
  the existing patches. **Recommended.**

## 6. Phased plan (incremental, safe to roll out gradually)

- **Phase 0 — Prereqs.** ✅ *Code done (2026-07-01):* scaffolded `ConversationDO`
  (`worker/conversation-do.ts`), wired the DO **binding + `migrations` (tag `v1`,
  `new_sqlite_classes`) through the `CloudflareDeployer` constructor** in `mastra/index.ts`
  (deployer spreads `userConfig` into the generated `wrangler.jsonc` — verified present),
  exported the class from the built entry via the `getEntry()` override, added a bearer-secured
  `/internal/do-ping` RPC health check, and stubbed `cloudflare:workers` for vitest. Typecheck +
  63/63 unit tests green. **✅ Deployed (version `89c6bee8`): Workers Paid enabled, `v1`
  migration applied, deploy output confirms `env.CONVERSATION_DO (ConversationDO)` bound.**
  No behavior change.
- **Phase 1 — Turn into the DO.** ✅ *DONE & rolled out to ALL tenants (2026-07-01,
  `DO_TURNS=*`, current version `a4fef714`).* `ConversationDO.scheduleTurn()` stores the turn +
  arms a durable 15s Alarm (each inbound resets it → debounce); `alarm()` rebuilds the agent and
  runs the existing `runAgentTurn`. **Since 2026-08-27 the `scheduleTurn` call runs inside
  `ctx.waitUntil`, after the webhook has answered GHL** — awaiting it in the request had put DO
  latency on GHL's ~10 s timeout (a 10 s stall got the request and the RPC canceled, turn lost).
  The `turn_scheduled` event and the legacy fallback ride in the same promise
  (`scheduleOnDurableObject`). `handleInboundWebhook` routes to the DO when
  `doTurnsEnabled(tenant)` (env `DO_TURNS`: empty=off, `*`/`all`=every tenant, else comma list of
  tenant ids), with a **fall-through to the legacy `waitUntil` path** if the DO call throws. DO
  constructor mirrors string bindings into `process.env`. **Reconciliation cron stays as net.**
  Two fixes were needed mid-rollout, both instructive for later phases:
  - **`workerEnvStorage`** (`core/execution-ctx.ts`): the DO namespace binding is an object, so
    it's NOT in `process.env` (strings only) and not reliably on Hono's `c.env` under Mastra.
    The real Worker `env` is now threaded via AsyncLocalStorage (same pattern as
    `executionCtxStorage`), populated in the `getEntry()` entry wrapper. Read
    `CONVERSATION_DO` from there.
  - **migration `0027`**: `bot_events.event_type` has a CHECK constraint; `turn_scheduled` had to
    be added to it (was silently failing the insert).
- **Phase 3 — Remove the patches (RECOMMENDED NEXT).** After a monitoring window with
  `DO_TURNS=*` (confirm turns run via the DO with no drops/double-sends; check `bot_events`
  `turn_scheduled` present and no `run_superseded` storms / reconciliation re-runs), delete the
  compensating patches now made redundant by the serialized+durable DO:
  reconciliation (`worker/reconciliation.ts` + its cron + `app_load_unanswered_turns` +
  `runReconciliationSweep` export/scheduled call), the `reconcile_claimed_at` claim
  (`claimTurnForProcessing` + column), and — optionally — the legacy `waitUntil` fall-through in
  `handleInboundWebhook`. Keep the `messages.ghl_message_id` unique dedup. *(~1 day + monitoring)*
- **Phase 2 — Follow-ups into the DO (OPTIONAL / LOWEST PRIORITY).** *Re-scoped:* Phase 1 already
  made follow-up **scheduling** durable (`scheduleFollowUp` runs inside the durable DO `alarm()`).
  This phase only retires the 1-min follow-up **polling** cron in favour of exact-time DO alarms —
  elegance, not durability. Real cost: it must **multiplex the DO's single alarm** between
  "debounced turn due" and "follow-up due" (store both target times, `setAlarm(min(...))`, and in
  `alarm()` run whichever is due then re-arm), and it touches every tenant's follow-up delivery.
  If done, keep the follow-up cron as a net (the load-due claim must be atomic so cron+DO don't
  double-send) until proven. **Recommendation: defer indefinitely unless the cron becomes a
  problem.** *(~1–2 days)*
- **Phase 4 — Cleanup & docs.** Simplify Fix A/B notes, update `CLAUDE.md` turn-durability
  section and `business-logic.md`. *(~0.5 day)*

The durability goal is **already achieved** (Phase 1). Phases 3–4 are cleanup; Phase 2 is
optional. Nothing below is time-critical.

## 7. Risks / notes / RESUME POINT

**▶ Where we stopped (2026-07-01):** Phase 1 is DONE and rolled out to ALL tenants
(`DO_TURNS=*`, version `a4fef714`). Turns run through `ConversationDO`; reconciliation + the
follow-up cron are still running as nets. The durability goal is achieved — we paused here
deliberately (see the KEY INSIGHT at the top).

**▶ When you resume — do this:**
1. **Monitor** (a few days of real traffic). Sanity queries on `bot_events` / `messages`:
   - `turn_scheduled` events appearing for real conversations (DO path is taken).
   - No dropped turns needing reconciliation recovery (i.e. reconciliation `claimed` count near
     zero — check `[cron] reconcile:` logs / the sweep), and no double-sends.
   - `wrangler tail` spot-check shows `scheduleTurn → Alarm → turn → reply`.
2. **Phase 3 (recommended next):** once clean, delete the now-redundant patches — see the Phase 3
   bullet in §6. Do it in one PR, keep `messages.ghl_message_id` dedup, and remove the
   `waitUntil` fall-through only after you're confident (or keep it as a cheap belt).
3. **Phase 2 (optional, likely skip):** only if you want to retire the follow-up polling cron.
   Requires single-alarm multiplexing (turn vs follow-up) in `ConversationDO`; keep the cron as a
   net with an atomic due-claim. Not worth the risk unless the cron becomes a problem.

**▶ 2026-08-25 — the alarm now does double duty (pause-resume, 0053).** Deleting the
reconciliation cron in Phase 3 quietly lost one thing it did by accident: re-running a turn that
had been *suppressed* by the human pause once the pause expired (`app_load_unanswered_turns`
filtered on `human_active_until < NOW()`). With the DO, a suppressed turn was simply dropped.
Fixed inside the DO rather than with a new cron: `alarm()` reads `resumeAt` off the suppressed
turn's result, stores the turn back flagged `resumed`, and re-arms the same alarm for the expiry
(+5 s). No multiplexing needed — a newer inbound's `scheduleTurn` overwrites the pending turn
and its 15 s alarm wins (the DO checks for that before putting the resumed turn back). This is
NOT Phase 2 (follow-ups stay on the cron); it is the one piece of "re-check later" the DO now
owns. Gate + classifier: `worker/resume-gate.ts`, business-logic §3.

**Rollback of the whole DO path if ever needed:** set `DO_TURNS` empty (`echo -n "" | wrangler
secret put DO_TURNS`) → every tenant instantly falls back to the legacy `waitUntil` path; the DO
class stays deployed but idle. No redeploy needed.

**Other notes:**
- **DO migrations are sticky** — `ConversationDO` / tag `v1` can't be casually renamed.
- **`workerEnvStorage`** is how any future binding (not just the DO) reaches route handlers —
  `process.env` only carries string secrets/vars, not binding objects.
- **New `bot_events.event_type` values need a migration** (CHECK constraint — see `0027`).
- **Test locally** with `scripts/simulate-webhook.mjs` (DO works under `wrangler dev`; the
  `/internal/do-ping` route is a binding health check).
