# Status Classification & GHL Pipeline Sync — Analysis + Implementation Plan

> Audience: an implementing agent (Sonnet). This doc is **analysis + plan only** — no code was
> changed producing it. Part 1 evaluates how we set conversation status today and recommends what
> to keep/change. Part 2 designs a generic, tenant-agnostic way to sync GHL tags and pipeline
> stages. The two parts are linked: the pipeline sync **reuses** the post-turn classifier rather
> than adding a second AI pass.

---

## Background: the two-dimensions insight (read this first)

There are **two orthogonal state dimensions** in a conversation. Conflating them is the main
trap; keep them separate.

1. **Conversation status** — `active | handed_off | completed | opted_out | standby` (+ legacy
   `closed`). This drives **bot behavior**: whether follow-ups fire, whether the bot is
   suppressed, whether the thread can be reactivated. It is an *internal runtime* concern.
   Source of truth: `conversations.status`. Set today by `app_update_conversation_status`.

2. **Sales outcome / pipeline stage** — e.g. `New Lead → Qualified → Appointment Booked →
   Disqualified → Opted Out`. This drives **CRM segmentation, lead tracking, and the human sales
   process** inside GHL. It is an *external/business* concern that humans and reporting consume.

They overlap but are **not** the same. Example: two conversations both end at status `completed`,
but one because the lead **booked** (outcome: `appointment_booked`) and one because the lead
**doesn't qualify** (outcome: `disqualified`). Same status, different pipeline stage. This is
exactly what `TODO.md:27` already calls out, and it is correct.

---

# Part 1 — Is the separate classifier the best way to set status right now?

## What we do today (as built)

Two mechanisms run in parallel (`workers/src/worker/webhook-handler.ts`):

1. **Tool the agent may call** — `updateConversationStatusTool`
   (`roles/front-desk/tools/update-conversation-status.ts`), instructed in the prompt
   (`prompt.ts:95-103`): "call updateConversationStatus FIRST, then write your closing message."
2. **Separate post-turn classifier** — `classifyConversationOutcome()` in `webhook-handler.ts`.
   After every bot reply, if the reply contains **no `?`**, it makes its own raw-`fetch` LLM call
   (OpenAI or Anthropic) with a focused prompt and returns `standby | opted_out | completed`
   (or null = still active). On a terminal result it calls `app_update_conversation_status`.

So in practice the classifier is the **reliable backstop**, and the tool is the unreliable
primary. They can both fire on the same turn.

## Why the tool-only approach failed (and it's a real, known failure mode)

The team's read is correct: LLMs frequently **skip tool calls that don't affect their own
output** — "side-effect-only" tools. When the model can satisfy the user by just emitting text, a
fire-and-forget bookkeeping tool is the easiest thing to drop, especially under a token budget or
when the closing message feels "done." This is well-documented behavior, not a prompt bug you can
fully reliably fix. Trusting it for a state transition that gates follow-ups (i.e. that can spam a
lead who already said goodbye) is the wrong risk tradeoff.

## Assessment of the current hybrid

**Verdict: keep the separate classifier. It is the right architecture for our stated values**
(reliability is a first-class feature — the whole reason we left n8n). A deterministic,
always-runs post-turn classifier trades a small, bounded cost for a state transition we can
actually rely on. Don't migrate it. But tighten it — there are real rough edges:

1. **Both paths are active and partially redundant.** The tool path is mostly dead weight: it adds
   prompt complexity/tokens (`prompt.ts:95-103`) for a transition the classifier already handles
   more reliably. Worse, on a turn where both fire they can momentarily disagree.
2. **The `?` heuristic is fragile in both directions.**
   - *False negatives:* a terminal turn can still contain a `?` ("Listo, te esperamos el martes
     a las 4, ¿te late?") → classifier never runs → status stays `active` → follow-ups fire on a
     booked lead. This is the exact harm we're trying to prevent.
   - *Wasted calls:* many non-`?` replies are mid-flow and classify back to `active`.
3. **`handed_off` is not covered by the classifier** (its enum is
   `active|standby|opted_out|completed`). Handoff therefore relies on the unreliable tool **or**
   the `"AGENTE"` keyword path. Worth making deterministic.
4. **Raw `fetch` duplicates provider branching** that the AI SDK / Mastra model layer already
   solves, and lives apart from the rest of the model code. Minor tech-debt, but it will double
   when Part 2 lands unless we unify (see below).

## Alternatives considered

- **(A) Single structured output from the main agent** (the "JSON with actions + response" idea):
  generate the reply and the status in one structured object, so the model *must* fill the field
  (no compliance gap, one call). *Why not now:* structured/`experimental_output` and live
  tool-calling don't compose cleanly across AI-SDK/Mastra versions (you want both tool calls
  *and* a final typed object in the same turn), and forcing JSON tends to degrade conversational
  quality in the free-text reply. High integration risk for marginal benefit over a working
  classifier. Revisit only if the SDK makes "tools + final object" first-class.
- **(B) Keep the classifier, refine it** (recommended — see below).
- **(C) Always run the classifier** (drop the `?` gate). Most reliable, small extra cost. Good
  middle option if we want to kill the false-negative risk without other changes.

## Recommended changes to Part 1 (small, do these regardless of Part 2)

1. **Make the classifier the single source of truth for `completed | standby | opted_out`.**
   Drop the status-setting tool from the prompt (or keep the tool in the registry but remove the
   instructions block at `prompt.ts:95-103`). Less prompt surface, no dual-writer ambiguity.
2. **Handle `handed_off` deterministically**, not via the classifier or a flaky tool: the
   `"AGENTE"` keyword path already exists — route handoff through that + any explicit
   out-of-scope rule. (If you keep one tool, keep it *only* for handoff.)
3. **Replace the `?` gate with a cheaper, safer trigger.** Either (a) always classify (option C),
   or (b) keep a gate but make it inclusive — e.g. run whenever the reply has no `?` **or**
   contains closing/booking cues. Given the harm is "follow-up spam on a finished lead," prefer
   erring toward running it.
4. **Fold the raw-`fetch` classifier into one shared helper** that both status and the Part 2
   outcome use (see Part 2 — it should be a *single* post-turn classification call returning both
   dimensions). Reuse the provider/key resolution already in the request-context layer instead of
   re-branching on `provider` inline.

> Net: the separate classifier stays; we remove the redundant tool path, make the trigger safe,
> and prepare it to also emit the sales outcome so Part 2 doesn't add a second LLM pass.

---

# Part 2 — Generic GHL tag & pipeline sync

## Should the front-desk agent do this? (the core question)

**No — do not give the conversational agent tag/pipeline tools.** Reasons:

- **Same reliability failure as status.** These are side-effect-only tools; the model will skip
  them. We just concluded we can't trust that for status — tags/stages are no better.
- **Taxonomy is tenant-specific.** Tag names and pipeline stage IDs differ per client. Driving
  them from the agent would require injecting each tenant's tag/stage vocabulary into the prompt
  — prompt bloat, and a per-tenant prompt concern, which violates "tenant values never live in
  the agent's reasoning surface."
- **Separation of concerns.** Sales-ops segmentation is not a conversational concern. The agent's
  job is the conversation; CRM bookkeeping should be derived from the conversation, deterministically.

## Should it be a separate AI pipeline / role?

**No new agent/role for the classification, and no AI at all for the application step.** The play:

- **Reuse the post-turn classifier** (the one from Part 1) to emit a normalized **outcome** enum.
  One LLM call per turn produces *both* the status dimension and the outcome dimension. No second
  AI pass, no new role.
- **The sync itself is deterministic application logic**, not AI: outcome → look up the tenant's
  configured mapping → call GHL. A new Mastra *role* would only be justified if we later wanted an
  autonomous CRM agent doing nuanced multi-step opportunity management. For tag/stage segmentation,
  a config-driven executor is more reliable, cheaper, and easier to reason about. Don't over-build.

This fits our architecture rule cleanly: **code = product** (the outcome taxonomy + the sync
engine), **DB = per-tenant variables** (the outcome→tag/stage mapping).

## Design

### 1. Outcome taxonomy (code-level, generic — distinct from status)

Define a normalized enum in `core/types.ts`. Generic across every tenant; tenants map these to
their own tags/stages, they don't invent new outcomes. Proposed starting set:

| outcome              | meaning                                                        | typical status |
| -------------------- | ------------------------------------------------------------- | -------------- |
| `in_progress`        | conversation ongoing, no terminal signal yet                  | `active`       |
| `qualified`          | lead fits the profile / showed real intent, not yet booked    | `active`       |
| `appointment_booked` | lead booked / registered / completed the funnel               | `completed`    |
| `disqualified`       | lead does not fit the profile (no business, wrong audience…)  | `standby`      |
| `opted_out`          | lead explicitly asked to stop being contacted                 | `opted_out`    |
| `needs_human`        | handed off to a person                                        | `handed_off`   |

Keep status derivable from outcome via a fixed map (the right column). Two ways to wire it:
- **Preferred:** the single classifier returns `{ outcome }`, and code derives `status` from the
  map above. One field to reason about; status stays an internal projection.
- **Acceptable:** classifier returns `{ status, outcome }` explicitly. Slightly more prompt, but
  decouples the two if they ever diverge.

Pick the preferred form unless you hit a case where status must differ from the outcome's default.

### 2. Per-tenant mapping config (DB)

Add a `pipeline_config` jsonb column to `tenant_config` (new migration). Shape:

```jsonc
{
  "enabled": true,
  "pipelineId": "abc123",            // optional; only if using opportunities/stages
  "outcomes": {
    "qualified":          { "addTags": ["bot-calificado"],   "stageId": "stage_qualified" },
    "appointment_booked": { "addTags": ["cita-agendada"],    "removeTags": ["bot-calificado"], "stageId": "stage_booked" },
    "disqualified":       { "addTags": ["no-califica"],       "stageId": "stage_disqualified" },
    "opted_out":          { "addTags": ["no-contactar"],      "stageId": "stage_lost" },
    "needs_human":        { "addTags": ["requiere-humano"] }
    // outcomes with no entry → no-op. in_progress → always no-op.
  }
}
```

Rules:
- Every field optional. Missing outcome entry = do nothing. `enabled: false` or absent column =
  feature off for that tenant (default off → zero behavior change on rollout).
- Validate with a zod schema (mirror the front-desk config pattern in `roles/front-desk/config.ts`).
  Surface this slice through `RawTenantConfig` like `followUpTiers` already is.

### 3. GHL client methods (transport only)

Add to `ghl/client.ts` (keep the existing "confirm against GHL docs before wiring live" posture —
mark endpoints `TODO(GHL)` until verified, same as `bookAppointment`):

- `addContactTags(contactId, tags: string[])` → `POST /contacts/{contactId}/tags`, body `{ tags }`.
- `removeContactTags(contactId, tags: string[])` → `DELETE /contacts/{contactId}/tags`, body `{ tags }`.
- `upsertOpportunityStage(contactId, pipelineId, stageId)` — only if a tenant configures stages:
  - find existing opportunity for the contact: `GET /opportunities/search?contact_id={id}` (or
    location-scoped search), else create: `POST /opportunities/`.
  - move stage: `PUT /opportunities/{opportunityId}` with `{ pipelineStageId: stageId }`.

> ⚠️ **Endpoint shapes/paths above are from general GHL (LeadConnector) API knowledge and must be
> confirmed against the live API docs**, consistent with the repo's existing `TODO(GHL)` convention
> (`ghl/client.ts:9`, `ghl/types.ts:8`). Tags are simple; opportunities are the part most likely to
> need adjustment (search-by-contact + create-if-missing). **Recommend shipping tags first**
> (lower risk, covers most segmentation needs) and treating pipeline-stage moves as a fast-follow.

### 4. OAuth scopes — BLOCKER, plan for re-consent

Current scopes (`ghl/oauth.ts:18-23`) are read-only for contacts and have **no opportunities
scope**:

```
conversations/message.readonly, conversations/message.write,
calendars/events.write, contacts.readonly
```

To write tags/opportunities you must add (confirm exact strings in GHL docs):
- `contacts.write` (for tags)
- `opportunities.write` + `opportunities.readonly` (for pipeline stages / search)

**Adding scopes requires every existing tenant to re-install / re-consent the GHL app.** This is
an operational migration, not just a code change — call it out in the rollout. Until a tenant has
re-consented with the new scopes, the sync must **degrade gracefully** (detect 401/403 from GHL,
log a `bot_event`, never throw into the turn).

### 5. Where it runs + idempotency

- Run in `runAgentTurn` (`webhook-handler.ts`), **after** the unified classifier produces the
  outcome, in the same `waitUntil` tail where status update + follow-up scheduling already happen.
  Front-desk turns only for now (reactivation agent doesn't need it).
- **Apply only on outcome change.** Add `last_outcome text` (and `ghl_opportunity_id text`) to
  `conversations` (new migration). If the new outcome equals `last_outcome`, skip — don't re-tag
  every turn. Update `last_outcome` only after a successful (or best-effort) apply.
- **Failure isolation (non-negotiable):** GHL tag/stage calls must never block or fail the reply.
  Wrap like the classifier — try/catch, log to `bot_events`, return. A CRM hiccup must not cost us
  a customer reply.
- **Observability:** emit a `bot_event` on every outcome transition and on every GHL sync
  success/failure (`logEvent` already exists), so we can audit segmentation in production.

### 6. Suggested implementation order (for the Sonnet agent)

1. **Part 1 cleanup** (decouple to one classifier source of truth, fix the `?` gate, fold raw
   fetch into a shared `classifyTurn()` helper that returns `{ outcome }`). Land this first — it's
   self-contained and de-risks Part 2.
2. **Outcome taxonomy** in `core/types.ts` + outcome→status map. Make `classifyTurn()` return the
   outcome; derive + write status from it.
3. **Migrations:** `tenant_config.pipeline_config jsonb`; `conversations.last_outcome text`,
   `conversations.ghl_opportunity_id text`. New numbered files under `supabase/migrations/`.
4. **Config schema + plumbing** (zod schema, `RawTenantConfig`, queries to read `pipeline_config`).
5. **GhlClient.addContactTags / removeContactTags** (tags first; mark `TODO(GHL)` until verified).
6. **Sync executor** — pure function `outcome + tenant.pipelineConfig → GHL calls`, gated on
   `last_outcome` change, wired into `runAgentTurn`'s tail with full failure isolation + events.
7. **OAuth scope bump + re-consent runbook** (separate, coordinated with tenant onboarding).
8. **Opportunities/pipeline stage** as a fast-follow once tags are proven and the opportunities
   endpoints are confirmed.

## What NOT to do

- Don't give the conversational agent tag/pipeline tools (reliability + taxonomy-in-prompt).
- Don't add a second LLM pass for outcome — extend the one post-turn classifier.
- Don't create a new Mastra role for this; the application step is deterministic.
- Don't let a GHL CRM failure ever affect the conversation reply.
- Don't ship scope changes without the tenant re-consent migration plan.

## Open questions to confirm before wiring live calls

- Exact GHL endpoints/verbs/bodies for tag add/remove and opportunity search/create/stage-move,
  and the exact OAuth scope strings (`contacts.write`, `opportunities.*`). (`TODO(GHL)` convention.)
- Whether any tenant actually wants pipeline **stages** now, or whether **tags alone** cover the
  near-term segmentation need (affects whether opportunities work is needed at all in v1).
- Should outcome sync also fire from the reactivation flow, or front-desk only? (Plan assumes
  front-desk only for v1.)
</content>
</invoke>
