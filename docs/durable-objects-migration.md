# Future Upgrade — Turn/Follow-up Durability via Durable Objects

> **Status: IN PROGRESS — Phase 1 code DEPLOYED, flag-gated rollout STARTED (2026-07-01).**
> Phase 0 done (version `89c6bee8`). Phase 1 (version `ee4f6507`): the durable-turn path is
> live behind the `DO_TURNS` flag and **currently active for the The Bot Crew tenant only**
> (`DO_TURNS` = its tenant id). Everyone else stays on the legacy `waitUntil` path; the
> reconciliation cron stays on as the net. **Next: verify on the test conversation, then set
> `DO_TURNS=*` to roll out to all tenants; then Phase 2.** Owner: Leo. Resume point + effort
> at the bottom (§7). Read §1–§2 first when you pick this up cold.

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
- **Phase 1 — Turn into the DO.** 🚧 *Code done + deployed (2026-07-01, version `ee4f6507`),
  flag-gated rollout in progress.* `ConversationDO.scheduleTurn()` stores the turn + arms a
  durable 15s Alarm (each inbound resets it → debounce); `alarm()` rebuilds the agent and runs
  the existing `runAgentTurn`. `handleInboundWebhook` routes to the DO when `doTurnsEnabled(tenant)`
  (env `DO_TURNS`: empty=off, `*`/`all`=every tenant, else comma list of tenant ids), with a
  **fall-through to the legacy `waitUntil` path** if the DO call throws. DO constructor mirrors
  string bindings into `process.env` so `core/env.ts` secret reads work in the isolate. Currently
  `DO_TURNS` = The Bot Crew tenant id (rollout of one). **Reconciliation cron stays as the net.**
  **⏳ Remaining: verify on the test conversation → `DO_TURNS=*` for all tenants.** *(~2–3 days)*
- **Phase 2 — Follow-ups into the DO.** Move follow-up scheduling to DO Alarms; retire the
  follow-up cron + `app_load_due_follow_ups`. *(~1–2 days)*
- **Phase 3 — Remove the patches.** Delete reconciliation, the claim, `reconcile_claimed_at`,
  and `app_load_unanswered_turns` once Phases 1–2 are proven in prod. *(~1 day + a monitoring
  window)*
- **Phase 4 — Cleanup & docs.** Simplify Fix A/B notes, update `CLAUDE.md` turn-durability
  section and `business-logic.md`. *(~0.5 day)*

Rough total: **~1–1.5 weeks** of focused work, rollable phase by phase (each phase is shippable
and reversible; the safety net stays until Phase 3).

## 7. Risks / notes / RESUME POINT

- **DO migrations are sticky** — the class name + migration tag can't be casually renamed;
  plan the name once (`ConversationDO`).
- **Keep DB writes idempotent** — the `messages.ghl_message_id` unique constraint stays our
  dedup backstop regardless of primitive.
- **Gradual rollout** — Phases 1–2 run *alongside* reconciliation; only remove it in Phase 3
  after a clean monitoring window, so a bug can't cause a regression with no net.
- **Test locally** with `scripts/simulate-webhook.mjs` (DO works under `wrangler dev`).

**▶ Where to resume (next action):** Phase 1 is deployed and active for The Bot Crew only.
**(1) Verify** on the test conversation: send a message, confirm a `turn_scheduled` bot_event
(`via: durable-object`) and that the reply lands (~15s later, no drop), and that a rapid burst
coalesces into one reply. **(2) Roll out:** `echo -n "*" | wrangler secret put DO_TURNS` to
enable all tenants; watch for a monitoring window. **(3) Phase 2:** move follow-up scheduling to
a DO alarm (add a second alarm purpose or a follow-up-specific key) and retire the follow-up cron
+ `app_load_due_follow_ups`. Note: `ConversationDO` currently uses a single alarm for the debounce;
Phase 2 needs the alarm to distinguish "debounced turn due" vs "follow-up due" (store the alarm
purpose alongside the pending state). Update this **Status** line + checkboxes as you go.
