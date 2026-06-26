# Implementation Plan — Testing Strategy (P0)

> ✅ **PARTIAL — Layers 1–2 + the CI gate are SHIPPED.** `pnpm test:unit` (no keys/network/DB)
> covers webhook parsers + signature verification (`verifyDetached` keypair round-trip), the gate
> helpers / keyword matcher, and mocked-seam orchestration of `handleInboundWebhook` (dedup,
> suppression, channel/keyword gates, happy path, delivery failure). `.github/workflows/ci.yml`
> runs typecheck + `test:unit` on every push/PR. **Still pending:** Layer 3 golden-conversation
> live set (the staging deploy gate) + Layer 1 for the FAQ matcher / prompt / classifier. Original
> plan below.

> Hand-to-implementer plan. Goal: back the "reliability is a first-class feature" claim with an
> actual test harness, and make it the deploy gate so AI-driven changes are safe to ship. Today the
> only tests are prompt-string assertions + two live smell-tests (`front-desk.eval.ts`); the
> orchestration logic most likely to break is untested. Referenced by
> `docs/production-readiness-and-roadmap.md` (P0) and underpins the webhook-auth and
> durable-execution plans (both ship with tests).

## Current state

- Vitest configured (`vitest.config.ts`) to pick up `*.eval.ts` and `*.test.ts`; live cases
  self-skip without an API key. `pnpm eval` = `vitest run`.
- No unit tests on: webhook parsing/verification, dedup, suppression, the debounce gate, follow-up
  tier transitions, echo detection, the FAQ matcher, the status classifier gate.

## Three layers to build

### Layer 1 — Pure-function unit tests (fast, no mocks, always run)

These are deterministic and cover the parsing/decision logic that silently breaks. Target ~all of
these as `*.test.ts` next to the source:

- `ghl/webhook.ts`: `parseInboundWebhook` (valid, missing fields, non-`InboundMessage` type,
  `direction!=inbound`, phone-from-`from` fallback, channel normalization), `parseOutboundWebhook`
  (skip `source:'api'` echoes, skip missing `userId`, accept `source:'app'`), `normalizeChannel`.
- `ghl/webhook.ts`: **`verifyWebhook`/`verifyGhlSignature`** — valid signature, tampered body,
  missing header, wrong key, dev escape hatch off-by-default. Use a generated test RSA keypair +
  fixture body to produce a known-good signature (WebCrypto works in Node 20+ vitest).
- `roles/front-desk/tools/lookup-faq.ts`: the tokenizer (accent stripping, stopwords) and scorer
  (best-match ordering, empty-FAQ, no-overlap → returns whole FAQ).
- `roles/front-desk/prompt.ts`: section rendering with/without overrides (some exists in eval).
- Status classifier helpers (post Part-1 refactor): the `?`-gate / trigger logic and the
  outcome→status mapping (see `status-classification-and-ghl-pipeline-sync.md`).

### Layer 2 — Orchestration tests (mocked seams, always run)

The highest-value, currently-missing layer. The clean seam is the **`db/queries.js` module** plus
**`GhlClient`** and **`agent.generate`** — mock all three with `vi.mock`, then drive
`handleInboundWebhook` / `runAgentTurn` and assert behavior. No DB, no network, no model.

Cases to cover (each a known past/likely failure):
- **Dedup:** `logMessage` returns null conversationId → handler returns `duplicate message`, no
  agent run.
- **Suppression:** `isBotSuppressed` → true → no generate, no send.
- **Role disabled:** `roleEnabled` false → ignored.
- **Debounce gate:** `isLatestInboundMessage` false → skip as `superseded`; true → proceeds.
- **Happy path:** generate → `logMessage(outbound)` → `sendMessage` → `setGhlMessageId` +
  `markDelivered` → `scheduleFollowUp(tier1)` all called in order with expected args.
- **Send failure:** `sendMessage` throws on both attempts → row left pending, error logged, no
  crash, follow-up still scheduled appropriately.
- **Model failure:** `agent.generate` throws → (post durable-execution) rethrows for retry; (today)
  returns 500 without partial side effects.
- **Idempotency guard** (lands with the queue work): a re-run of the same turn does not double-send.
- **Status classifier:** terminal outcome → `updateConversationStatus` called; active/`?` → not.
- **Follow-up runner** (`followup-runner.ts`): tier N sent → schedules tier N+1; last tier →
  `updateConversationStatus(standby)`; unknown tenant/tier → skip.

### Layer 3 — Golden-conversation regression set (live, gated, the deploy gate)

Multi-turn scripted conversations run against the real agent (gated on `ANTHROPIC_API_KEY`/
`OPENAI_API_KEY`, like today's live cases). Each fixture = an ordered list of lead messages + a set
of **deterministic assertions** on the agent's behavior across the conversation. Build them from
real tenant config (the Bot Crew + the demo tenant). Examples:

- **Qualification:** opener → agent asks qualifying questions, mentions only configured services.
- **Booking intent:** ready-to-book → agent calls `getAvailability` before proposing a time.
- **Anti-hallucination:** asks for a price not in config → no fabricated currency amount (the
  existing case, expanded to address, hours, promotions).
- **Opt-out:** "no me contacten" → terminal status set, no further engagement.
- **Out-of-scope / handoff:** asks for something unsupported / "AGENTE" → handoff path.

Scoring: prefer deterministic regex/string assertions where possible (cheap, stable). For
fuzzier judgments (tone, "did it stay grounded"), use a **Mastra scorer / LLM-judge** with a
rubric — these double as the seed for the QA/Supervisor agent in the monitoring roadmap. Keep the
judge model + prompt versioned.

## Tooling & scripts

- Split scripts: `test:unit` (Layers 1–2, no API key, runs everywhere + CI on every PR) vs
  `eval` / `test:live` (Layer 3, gated on API key, runs on a schedule and pre-deploy). Update
  `package.json` and `CLAUDE.md` workflows.
- **CI gate:** Layers 1–2 block every merge. Layer 3 runs against **staging** pre-deploy and blocks
  promotion on regression (this is the rail that makes agent-driven changes safe — roadmap P1).
- Consider `@cloudflare/vitest-pool-workers` later for workerd-fidelity tests (real bindings/
  WebCrypto/Queues). Not required to start — plain vitest + mocks + Node WebCrypto covers Layers 1–2.

## Sequencing (and how it interlocks with the other P0s)

1. **Layer 2 harness + the `vi.mock('../db/queries.js')` setup** — unblocks everything; do first.
2. **Layer 1 for `ghl/webhook.ts`** — lands *with* the webhook-auth plan (its acceptance criteria
   require these tests).
3. **Layer 1 for the rest** (FAQ, prompt, classifier).
4. **Idempotency + retry orchestration tests** — land *with* the durable-execution plan.
5. **Layer 3 golden set + CI gate + staging** — the standing safety net.

## Acceptance criteria

- `pnpm test:unit` runs with no API key, no network, and covers every Layer 1–2 case above.
- Webhook-auth and durable-execution PRs each include their tests (signature verification;
  idempotent no-double-send).
- A deliberately introduced regression (e.g. break the debounce gate or fabricate a price in the
  prompt) is caught by the suite.
- CI blocks merge on Layer 1–2 failure; staging deploy blocks on Layer 3 regression.
</content>
