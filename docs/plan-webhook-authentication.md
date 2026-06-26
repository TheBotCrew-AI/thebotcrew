# Implementation Plan — Webhook Authentication (P0)

> ✅ **IMPLEMENTED** (`ghl/webhook.ts` `verifyGhlWebhook`). Final scheme is **Ed25519**
> (`x-ghl-signature`, current) with **RSA-SHA256** (`x-wh-signature`, legacy → 2026-07-01)
> fallback — not RSA-only as this plan originally assumed. Verified in the route handlers
> over the raw body before parse, on all three routes. Original plan below.


> Hand-to-implementer plan. Goal: every inbound request from GHL is cryptographically verified
> before we act on it. Today `verifyWebhook()` accepts any request carrying *any* value in a
> signature header (`ghl/webhook.ts:27-32`) — effectively unauthenticated. Pairs with
> `docs/plan-testing-strategy.md` (the verifier must ship with tests) and is referenced by
> `docs/production-readiness-and-roadmap.md` (P0).

## What we're protecting

Two public POST routes in `mastra/index.ts` consume GHL payloads and trigger work/spend:
- `/webhooks/ghl` (inbound lead messages → runs the agent, costs model + GHL calls)
- `/webhooks/ghl/outbound` (human-agent messages → writes history, slides suppression timer)

Both must be verified. An unverified endpoint lets anyone inject messages, poison conversation
history, drive unbounded LLM cost, and spam your clients' leads.

## The scheme (confirm against GHL docs — `TODO(GHL)` convention)

GHL **App Marketplace** webhooks are signed with **RSA-SHA256 over the raw request body**, and the
signature arrives base64 in the **`x-wh-signature`** header. You verify it against **GHL's published
public key** (a fixed SPKI/PEM constant from their docs), *not* a per-tenant shared secret.

> ⚠️ Confirm before wiring: (a) exact header name (`x-wh-signature`), (b) that it's RSA public-key
> (marketplace apps) and not HMAC, (c) the current public key PEM from GHL docs. The repo already
> flags this as TBD (`TODO.md:11`, `ghl/webhook.ts:4`). Design for the public-key path; keep a
> narrow HMAC fallback only if GHL confirms a shared-secret scheme for this app.

Implications for config (`core/env.ts`):
- Replace the `GHL_WEBHOOK_SECRET` mental model (HMAC) with `GHL_WEBHOOK_PUBLIC_KEY` (the PEM), or
  embed GHL's public key as a code constant (it's public and rarely rotates). Prefer an env/secret
  so rotation doesn't need a deploy. Keep `webhookSecret` only if HMAC turns out to be in play.

## The critical detail: verify the RAW body, before JSON parsing

Today the route handler does `await c.req.json()` and *then* calls `verifyWebhook(headers, …)`
inside `handleInboundWebhook`. RSA/HMAC verification must run over the **exact raw bytes** GHL
signed — re-serializing the parsed object will not match. So verification must move up to the
route handler where raw bytes are available, and run *before* parse.

In Hono/Mastra route handlers: read `const rawBody = await c.req.text();` once, verify the
signature over `rawBody`, then `JSON.parse(rawBody)` for the payload. (Do not call `c.req.json()`
separately — the body can only be consumed once.)

## Implementation steps

1. **Rewrite `verifyWebhook` as an async, real verifier** in `ghl/webhook.ts`:
   - Signature: `async function verifyGhlSignature(rawBody: string, headers: Headers, publicKeyPem: string): Promise<boolean>`.
   - Use **WebCrypto** (available in Workers + Node 20+): `crypto.subtle.importKey('spki', …, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify'])`, then `crypto.subtle.verify(...)` over `new TextEncoder().encode(rawBody)` and the base64-decoded header signature.
   - Fail **closed**: missing header, missing/invalid key, or verify=false ⇒ return false. Remove
     the current `if (!secret) return true` production hole. Allow an explicit
     `ALLOW_UNVERIFIED_WEBHOOKS=true` escape hatch **only** for local dev (documented, off by default).
2. **Move verification into the route handlers** in `mastra/index.ts` for both `/webhooks/ghl`
   and `/webhooks/ghl/outbound`: read raw body → verify → on failure return `401` immediately
   (before any DB write or agent work) → on success `JSON.parse` and pass the parsed payload down.
   `handleInboundWebhook`/`handleOutboundWebhook` no longer verify internally (drop the
   `verifyWebhook` call at `webhook-handler.ts:321`); they receive already-verified payloads.
3. **Config plumbing** (`core/env.ts`): add `GHL_WEBHOOK_PUBLIC_KEY` (PEM) to `GhlEnv`; update
   `.dev.vars.example` and the deploy secret list. Note in `CLAUDE.md` GHL section that webhook
   verification is now RSA public-key.
4. **Constant-time / safe comparison** is handled by `crypto.subtle.verify` itself for RSA — no
   manual string compare. (If HMAC fallback is ever added, use a timing-safe compare.)
5. **Observability:** log rejected webhooks (count + reason) without logging the body, so spoof
   attempts are visible. A spike in 401s is an alerting signal (ties to the monitoring roadmap).

## Edge cases to handle

- **Replay:** RSA signature alone doesn't stop replay of a captured valid request. Message dedup
  (migration 0008, `ghl_message_id`) already neutralizes replayed *inbound message* events
  (duplicate id ⇒ ignored). Note this explicitly; optionally reject payloads with a `timestamp`
  older than a few minutes for defense-in-depth.
- **Body encoding:** ensure you verify over the byte-exact body. Beware any middleware that might
  transform it; read `c.req.text()` directly.
- **Key rotation:** if GHL rotates the public key, env-based key lets you rotate without a deploy.

## Acceptance criteria

- A request with a valid GHL signature → processed. Invalid/missing signature → `401`, no DB write,
  no agent run, no spend.
- Both `/webhooks/ghl` and `/webhooks/ghl/outbound` enforce it.
- No production code path returns `true` without verification (the dev escape hatch is explicit and
  off by default).
- Unit tests cover: valid signature, tampered body, missing header, wrong key, and the dev escape
  hatch (see `docs/plan-testing-strategy.md`). Use a fixture body + a test keypair to generate a
  known-good signature.

## Out of scope (note for later)

Per-tenant webhook secrets, IP allow-listing, and full OAuth callback CSRF (`state` store/compare,
tracked separately in the roadmap as P1).
</content>
