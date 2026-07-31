# Config model — tenants, prompts, and what wins over what

> How a single deployed Worker turns into a different agent for every client, and which
> layer beats which when they disagree. Read this before adding a config field, a campaign,
> or a persona.
>
> Same maintenance rule as the rest of `docs/`: if a change alters the picture below, update
> it in the same change. Where this file and the code disagree, the code is right and this
> file is the bug.

---

## 1. The two halves

```mermaid
flowchart LR
    subgraph CODE["CODE — git, one deploy serves everyone"]
        direction TB
        C1["Role definitions<br/>agent + tools"]
        C2["Prompt TEMPLATE<br/>section order, defaults,<br/>booking + state rules"]
        C3["Orchestration<br/>gates, debounce, DO turn"]
    end
    subgraph DB["DATABASE — per tenant, no deploy"]
        direction TB
        D1["tenants / tenant_config<br/>hours, services, calendars, FAQ"]
        D2["prompt_overrides<br/>the tenant's voice"]
        D3["Gates + toggles<br/>channels, keywords, horizon"]
    end
    CODE -->|"rendered at request time"| PROMPT["The system prompt<br/>for THIS turn"]
    DB -->|"fills the placeholders"| PROMPT
```

**The rule that decides where something goes:** if changing it for one client should not
touch the others, it is DB. If it is how the product *works*, it is code. Editing a prompt
in the DB is live for that tenant the instant you write it — no deploy, and **no gradual
rollout**: it hits 100% of that tenant's leads immediately.

---

## 2. Which override set wins (per turn)

Every turn resolves exactly one override set, in `resolveEffectiveOverrides`
(`roles/front-desk/config.ts`).

```mermaid
flowchart TD
    START["Turn starts"] --> DEMO{"active_role<br/>= 'demo'?"}
    DEMO -->|"yes"| DP["demo_prompt_overrides<br/>(+ generated session persona)<br/><br/>REPLACES everything.<br/>No merge with base."]
    DEMO -->|"no"| VAR{"conversation has a<br/>pinned prompt_variant?"}
    VAR -->|"yes"| MERGE["variant MERGED over base<br/>field by field"]
    VAR -->|"no"| BASE["prompt_overrides (base)"]
    MERGE --> HOUSE["houseRules always<br/>re-sourced from BASE"]
    BASE --> HOUSE
    HOUSE --> OUT["Effective overrides"]
    DP --> OUT
```

Three things people get wrong here:

- **The demo persona does not merge.** It replaces the whole set. A rule you keep in base
  simply does not exist inside a demo — deliberately, because the demo is a roleplay of
  someone else's business.
- **The variant merge is a spread, so it replaces a whole FIELD**, not text within it. A
  variant that sets `qualificationNotes` wipes the base's entire flow text — including
  anything else written inside it. Nothing fails; the rule just stops happening.
- **`houseRules` is the one field a variant cannot touch.** That is its whole purpose.

---

## 3. What each layer may override

| Field | Base | Campaign variant | Demo persona |
| --- | --- | --- | --- |
| `identity` | ✅ | ✅ replaces | ✅ (own set) |
| `offering` | ✅ | ✅ replaces | ✅ (own set) |
| `qualificationNotes` (the FLOW) | ✅ | ✅ replaces | ✅ (own set) |
| **`houseRules`** (the RULES) | ✅ | ❌ **never** | 🚫 suppressed |
| `toolInstructions` | ✅ | ✅ merged **per key** | ✅ (own set) |
| `bookingEnabled` | ✅ | ✅ | ✅ |
| `confirmContactName` | ✅ | ❌ base only (handler backstop) | n/a |
| `followUpAngles` | tenant column | ✅ replaces pool | n/a (follow-ups off in demo) |

**Rule of thumb:** the *flow* belongs to the campaign; the *rules* belong to the tenant.
Anything that must survive a campaign goes in `houseRules`.

---

## 4. Prompt assembly order

`buildFrontDeskInstructions` (`roles/front-desk/prompt.ts`). Later sections carry more
weight with the model, which is why the governing rules render **after** the flow.

```mermaid
flowchart TD
    A["identity"] --> B["date + timezone + booking horizon"]
    B --> C["tone + format"]
    C --> D["golden rule (anti-hallucination)"]
    D --> E["offering — or services if no override"]
    E --> F["hours — ALWAYS rendered"]
    F --> G["FLOW: qualificationNotes<br/>or the built-in objective"]
    G --> H["HOUSE RULES<br/>'mandan sobre el flujo de arriba'"]
    H --> I["toolInstructions"]
    I --> J["reminder number / contact name /<br/>demo handoff / existing appointment"]
    J --> K["tool usage + booking + state sections"]
```

Two sections are **not** overridable and always render: `# Horario` (from the `hours`
column) and the booking/state blocks (from code, gated by `bookingEnabled`).

---

## 5. Gates — who even gets an answer

Config decides *whether the bot replies at all*, before any prompt is built. Inbound is
**always stored**; only the reply is gated (`worker/webhook-handler.ts`).

```mermaid
flowchart TD
    IN["Inbound webhook"] --> STORE["Store the message<br/>(always)"]
    STORE --> T{"test_contact_ids<br/>non-empty?"}
    T -->|"yes, and contact NOT listed"| STOP1["silent · test_mode_skip"]
    T -->|"yes, and contact listed"| KW
    T -->|"no"| CH{"channel in<br/>enabled_channels?"}
    CH -->|"NULL or missing"| STOP2["silent · channel_disabled"]
    CH -->|"yes"| KW{"trigger_keywords set<br/>and not yet activated?"}
    KW -->|"keyword missing"| STOP3["silent · keyword_required"]
    KW -->|"ok / already activated"| RUN["Run the turn"]
```

- `test_contact_ids` **outranks the channel gate** — a non-empty list means only those
  contacts get replies, on any channel. Forgetting to clear it silently drops every real
  lead (`test_mode_skip` in `bot_events` is the fingerprint).
- `enabled_channels = NULL` means **none**. New tenants are born silent on purpose.
- `trigger_keywords` is an **entry** gate, not per-message: once `bot_activated` is set the
  thread flows without the keyword.
- `keyword_variants` is a different list with a different job — it picks the *prompt*, not
  the *entry*. A keyword can appear in both.

Every blocked turn logs why, so "the bot is slow" is always answerable from `bot_events`.

---

## 6. Where a conversation's state lives

Prompt selection depends on per-conversation state, not just tenant config:

| Column (`conversations`) | Set by | Effect |
| --- | --- | --- |
| `active_role` | demo keywords, `startDemo`, demo end | `demo` → demo persona; `closer` → post-demo setter; NULL → normal |
| `prompt_variant` | first matching campaign keyword | pins the campaign flavor, **first touch sticky** |
| `role_started_at` | every persona transition | history loads from here — the clean-start rule |
| `bot_activated` | trigger-keyword match | the entry gate stays open afterwards |
| `status` | the agent's `updateConversationStatus`, follow-up runner | only `handed_off` mutes the bot; the rest govern follow-up eligibility (business-logic §2a) |

---

## 7. Onboarding a tenant, as a picture

```mermaid
flowchart LR
    S1["1 · clients + tenants<br/>+ tenant_config rows"] --> S2["2 · install the GHL app<br/>OAuth token per location"]
    S2 --> S3["3 · fill calendars<br/>+ reconcile with hours"]
    S3 --> S4["4 · test_contact_ids<br/>= your own contact"]
    S4 --> S5["5 · enabled_channels<br/>+ CLEAR test_contact_ids"]
    S5 -.->|"optional"| S6["6 · own AI key<br/>wrangler secret"]
```

Step 1 must precede step 2 — the OAuth callback resolves the tenant by `locationId` and
404s `unknown_location` otherwise. Everything except step 6 is DB-only: no redeploy.
Procedure and SQL: [`onboarding.md`](onboarding.md).
