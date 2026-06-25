# Implementation Plan — Durable Turn Processing (P0)

> Hand-to-implementer plan. Goal: a customer turn is never silently dropped. Today the 8s debounce
> is a `setTimeout` inside `ctx.waitUntil` (`webhook-handler.ts:377-383`) and a model/GHL failure
> just logs and returns (`webhook-handler.ts:221-233`) with no retry — an isolate eviction or a
> provider outage loses the reply, the follow-up, and the trace. Referenced by
> `docs/production-readiness-and-roadmap.md` (P0).

## The integration constraint (read first)

Mastra's `CloudflareDeployer` **owns `wrangler.jsonc`** (it's auto-generated — see the header in
`wrangler.jsonc`) and **owns the Worker entry point** via the `getEntry()` override in
`mastra/index.ts:172-213`. Any durable primitive (Queue consumer, Durable Object) needs (a) a
binding in wrangler config and (b) a handler/class exported from the entry module. Both pass
through the deployer. **This is the main risk and the first thing to spike**, not the queue logic
itself. Plan for it explicitly below with a fallback that needs neither.

## Recommended path: Cloudflare Queues + delayed delivery (not Durable Objects)

DOs give strict per-conversation ordering but are the highest-friction option against the deployer.
**Queues get ~90% of the value at far lower integration risk** and map cleanly onto the existing
design:

- **Debounce becomes queue delay.** On inbound: verify → persist inbound message → enqueue a
  `{ conversationId, messageId, … }` job with `delaySeconds: 8` → return `200`. The existing
  `isLatestInboundMessage(conversationId, messageId)` gate (`db/queries.js:269`) already handles
  "a newer message arrived, skip this one" — so burst debounce still works, but the wait is now
  **durable** (survives eviction) instead of a `setTimeout`.
- **Retries + DLQ replace silent drops.** The queue consumer runs `runAgentTurn`. A model/GHL
  failure throws → the queue **retries with backoff** (configurable `max_retries`) → on exhaustion
  the message lands in a **dead-letter queue** you can inspect/replay. No more lost customers.
- **The webhook gets fast and cheap.** Ingestion (verify + persist + enqueue) is decoupled from the
  expensive tail (generate + classify + send + schedule follow-up).

### Why this fits the current code

`runAgentTurn` (`webhook-handler.ts:175`) is already a self-contained unit that takes ids + tenant
and does gate→load→generate→log→send→schedule. It becomes the queue consumer body almost verbatim.
The `debounced` gate logic stays. The main change is *where* it's invoked from (queue consumer vs
`waitUntil` timer) and that throwing now means "retry" instead of "return 500".

## Implementation steps

1. **Spike the deployer binding (do this first, timebox it).** Determine how `CloudflareDeployer`
   exposes Queue producer/consumer bindings. Options in likely order of preference:
   - Native support via the deployer instance config (check `@mastra/deployer-cloudflare` for a
     `bindings`/`queues` passthrough).
   - Add `queue(batch, env, ctx)` to the `getEntry()` template (the team already overrides this for
     `scheduled` — same pattern) **and** inject the `[[queues.producer]]` / `[[queues.consumer]]`
     stanzas into the generated `wrangler.jsonc` via a post-build step or a committed override.
   - If neither is clean in the timebox, fall back to the **zero-infra net** below and revisit.
2. **Producer:** in the `/webhooks/ghl` flow, replace the `waitUntil(setTimeout→runAgentTurn)`
   block with `env.TURN_QUEUE.send(job, { delaySeconds: 8 })`. Keep the synchronous fallback path
   (no execution context / tests) calling `runAgentTurn` directly.
3. **Consumer:** a `queue` handler that, per message, calls `runAgentTurn({ …, debounced: true })`.
   On thrown error, **rethrow** (or call `message.retry()`) so the platform retries; on the
   superseded-skip and other expected no-ops, `ack`. Set `max_retries` (e.g. 3) + a DLQ binding.
4. **Idempotency (must-have for retries).** Retries mean `runAgentTurn` can run more than once for
   the same job. Guard the side effects:
   - The latest-message gate already prevents acting on superseded turns.
   - Before generating, check there isn't already an outbound reply *after* this inbound message
     (a cheap query) so a retry that already sent doesn't double-send. Or make the send idempotent
     by keying on the inbound `messageId`.
   - `scheduleFollowUp` is already RPC-guarded; confirm it no-ops on duplicate.
5. **Move follow-ups onto the same spine (phase 2).** The 1-minute cron + `loadDueFollowUps(20)`
   throughput ceiling (roadmap P1) can later become queue-driven (enqueue with `delaySeconds` =
   tier delay instead of DB polling). Not required for the P0 fix; note it as the natural follow-on.
6. **Update `CLAUDE.md`** architecture section: turn processing is queue-backed with retries + DLQ;
   debounce is durable delivery delay; the latest-message gate provides burst coalescing.

## Fallback: zero-infra durability net (ship even if the queue spike stalls)

If binding Queues through the deployer proves slow, you can close the *worst* gap — a dropped turn
— **today, with only a cron and a query**, no new infra:

- Add a **reconciliation sweep** to the existing scheduled handler: find conversations whose latest
  message is **inbound**, older than ~30–60s, with **no outbound reply after it**, and not
  suppressed → re-run `runAgentTurn` for them. This catches any turn lost to eviction or a
  transient model outage. It's idempotent if step 4's guards are in place.
- This is strictly worse than Queues (polling latency, coarser retries) but turns "silent
  permanent drop" into "recovered within a minute" with near-zero integration risk. Treat it as a
  stopgap and/or a permanent backstop *underneath* Queues.

## Acceptance criteria

- Killing the worker/isolate during the debounce window does **not** lose the reply (it fires after
  recovery via queue delay or the reconciliation sweep).
- A simulated `agent.generate` failure results in an automatic retry, and a persistent failure
  lands in the DLQ (or is recovered by the sweep) — never a silent drop.
- Burst of N messages still coalesces into one reply (latest-message gate intact).
- No double-send under retry (idempotency guard verified by a test).
- `pnpm typecheck` clean; orchestration tests updated (see `docs/plan-testing-strategy.md`).

## Why not Durable Objects (now)

DO-per-conversation is the eventual home for strict ordering + per-conversation locking/state, and
worth it later. But it's the heaviest lift against the Mastra deployer (exported class + migrations
+ bindings + routing), and Queues + the existing gate already remove the P0 failure modes. Revisit
DOs when per-conversation ordering or rich in-memory conversation state becomes the bottleneck.
</content>
