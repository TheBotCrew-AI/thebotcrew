/**
 * Stripe — the platform's payment rail for paid confirmation (0062).
 *
 * ONE Stripe account (the platform's), platform-level secrets, every tenant: the
 * lead pays the hold to us, because that is how the platform is paid under the
 * free-install offer. No per-tenant keys, no GHL payment provider.
 *
 * A tenant that gets paid DIRECTLY (Dr. Valdivia's deal) is a Stripe Connect
 * connected account (Standard) of that same platform account: every call for that
 * tenant carries `Stripe-Account: acct_…` (`booking_payment.stripe_account`) and the
 * same platform key. The charge lands in the tenant's account, the Checkout page
 * and the card statement carry the tenant's name, and the platform may take an
 * `application_fee_amount` off each one. The events of connected accounts arrive
 * signed with the CONNECT endpoint's secret (`STRIPE_CONNECT_WEBHOOK_SECRET`), a
 * second signing secret at the same URL.
 *
 * Thin fetch client, no SDK: three calls (create a Checkout Session, expire one,
 * verify a webhook signature). The SDK would pull Node shims into the Worker
 * bundle for what is two form-encoded POSTs and one HMAC.
 *
 * Secrets: `STRIPE_SECRET_KEY` (sk_live_/sk_test_), `STRIPE_WEBHOOK_SECRET` (whsec_…,
 * from the endpoint registered in the Stripe dashboard) and, optional,
 * `STRIPE_CONNECT_WEBHOOK_SECRET` (the "connected accounts" endpoint's). Third-party
 * credentials → Worker secrets, per the no-manual-secrets rule's exception.
 */

const STRIPE_API = 'https://api.stripe.com/v1';
/** Stripe caps Checkout expiry at 24 h after creation and floors it at 30 min. */
export const CHECKOUT_MAX_EXPIRY_MS = 24 * 60 * 60 * 1000;
export const CHECKOUT_MIN_EXPIRY_MS = 30 * 60 * 1000;
/** Default replay window for webhook timestamps (Stripe's own recommendation). */
const SIGNATURE_TOLERANCE_SEC = 300;

export interface StripeEnv {
  secretKey: string;
  webhookSecret: string;
  /** Signing secret of the connected-accounts endpoint. Absent = a connected account's event is rejected (401), loudly. */
  connectWebhookSecret?: string;
  mode: 'live' | 'test';
}

/**
 * Both secrets or nothing: a half-configured Stripe can't create a link the webhook
 * would then reject.
 *
 * `STRIPE_MODE=test` switches the whole Worker to the `*_TEST_MODE` pair (a test-mode
 * key + the signing secret of a test-mode endpoint), so the flow can be rehearsed on
 * prod with Stripe's test cards and no real charge. Both pairs stay set; flipping to
 * live is deleting the flag (or setting it to `live`), not re-entering keys. One mode
 * at a time on purpose: a live webhook against a test key would be rejected at the
 * signature and vice versa, and the hold row does not record which rail it used.
 */
export function getStripeEnv(): StripeEnv | null {
  const mode = process.env.STRIPE_MODE?.trim().toLowerCase() === 'test' ? 'test' : 'live';
  const suffix = mode === 'test' ? '_TEST_MODE' : '';
  const secretKey = process.env[`STRIPE_SECRET_KEY${suffix}`]?.trim();
  const webhookSecret = process.env[`STRIPE_WEBHOOK_SECRET${suffix}`]?.trim();
  if (!secretKey || !webhookSecret) return null;
  const connectWebhookSecret = process.env[`STRIPE_CONNECT_WEBHOOK_SECRET${suffix}`]?.trim();
  return { secretKey, webhookSecret, mode, ...(connectWebhookSecret ? { connectWebhookSecret } : {}) };
}

export interface CreateCheckoutSessionInput {
  amountCents: number;
  /** ISO 4217, lowercase (Stripe form). */
  currency: string;
  /** Line-item name the lead sees on the Checkout page ("Apartado — Consulta · Dr. Valdivia"). */
  productName: string;
  /** When the session stops accepting payment. Clamped to Stripe's [30 min, 24 h] window. */
  expiresAt: Date;
  /** Recorded on the session; the webhook resolves the hold by session id, this is for the dashboard. */
  metadata: Record<string, string>;
  /** Card-statement suffix (≤22 chars) so the lead recognizes the charge. */
  statementSuffix?: string;
  /** Stripe dedups on this: a retried create for the same appointment returns the same session. */
  idempotencyKey: string;
  successUrl: string;
  cancelUrl: string;
  /** Prefill the email field when known. */
  customerEmail?: string;
  /** Stripe Connect: the tenant's connected account (`acct_…`). The session, the charge and the
   *  money live THERE; the platform key only acts on its behalf (`Stripe-Account` header). */
  stripeAccount?: string;
  /** With `stripeAccount`: what the platform keeps of this charge, in cents. Ignored without one. */
  applicationFeeCents?: number;
  now?: number;
}

export interface CheckoutSession {
  id: string;
  url: string;
  /** Unix seconds. */
  expiresAt: number;
}

/** Clamp a wanted expiry into what Stripe accepts, relative to `now`. */
export function clampCheckoutExpiry(wanted: Date, now = Date.now()): number {
  const min = now + CHECKOUT_MIN_EXPIRY_MS;
  const max = now + CHECKOUT_MAX_EXPIRY_MS;
  const ms = Math.min(Math.max(wanted.getTime(), min), max);
  return Math.floor(ms / 1000);
}

/** Stripe's form encoding: nested keys as `a[b][c]=v`. */
function encodeForm(fields: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    params.append(k, String(v));
  }
  return params.toString();
}

async function stripePost(
  env: StripeEnv,
  path: string,
  fields: Record<string, string | number | undefined>,
  idempotencyKey?: string,
  stripeAccount?: string,
): Promise<Response> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${env.secretKey}`,
    'Content-Type': 'application/x-www-form-urlencoded',
  };
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  if (stripeAccount) headers['Stripe-Account'] = stripeAccount;
  return fetch(`${STRIPE_API}${path}`, { method: 'POST', headers, body: encodeForm(fields) });
}

/** POST /v1/checkout/sessions — a hosted, card-only, single-payment page in Spanish. */
export async function createCheckoutSession(env: StripeEnv, input: CreateCheckoutSessionInput): Promise<CheckoutSession> {
  const fields: Record<string, string | number | undefined> = {
    mode: 'payment',
    'line_items[0][quantity]': 1,
    'line_items[0][price_data][currency]': input.currency.toLowerCase(),
    'line_items[0][price_data][unit_amount]': input.amountCents,
    'line_items[0][price_data][product_data][name]': input.productName,
    // Card only for v1: OXXO takes up to 3 days to confirm and would outlive the hold.
    'payment_method_types[0]': 'card',
    locale: 'es-419',
    expires_at: clampCheckoutExpiry(input.expiresAt, input.now),
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    customer_email: input.customerEmail,
    client_reference_id: input.metadata.ghlAppointmentId,
  };
  if (input.statementSuffix) {
    fields['payment_intent_data[statement_descriptor_suffix]'] = input.statementSuffix;
  }
  if (input.stripeAccount && input.applicationFeeCents) {
    fields['payment_intent_data[application_fee_amount]'] = input.applicationFeeCents;
  }
  for (const [k, v] of Object.entries(input.metadata)) {
    fields[`metadata[${k}]`] = v;
  }

  const res = await stripePost(env, '/checkout/sessions', fields, input.idempotencyKey, input.stripeAccount);
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`[stripe] createCheckoutSession failed ${res.status}: ${detail.slice(0, 500)}`);
  }
  const data = (await res.json()) as { id?: string; url?: string | null; expires_at?: number };
  if (!data.id || !data.url) {
    throw new Error('[stripe] createCheckoutSession returned no url (session not open?)');
  }
  return { id: data.id, url: data.url, expiresAt: data.expires_at ?? 0 };
}

/**
 * POST /v1/checkout/sessions/{id}/expire — release the link when WE release the
 * slot (cron expiry, lead cancel). A session that is already expired or paid
 * answers 400; that is not a failure for the caller, so it is swallowed here
 * and only a real transport/auth error throws.
 */
export async function expireCheckoutSession(
  env: StripeEnv,
  sessionId: string,
  /** The connected account the session lives on, when it does — without it Stripe answers 404. */
  stripeAccount?: string | null,
): Promise<'expired' | 'already_closed'> {
  const res = await stripePost(env, `/checkout/sessions/${encodeURIComponent(sessionId)}/expire`, {}, undefined, stripeAccount ?? undefined);
  if (res.ok) return 'expired';
  if (res.status === 400) return 'already_closed';
  const detail = await res.text();
  throw new Error(`[stripe] expireCheckoutSession failed ${res.status}: ${detail.slice(0, 500)}`);
}

/** The slice of a Stripe event the webhook handler reads. */
export interface StripeEvent {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
  /** Set on an event from a connected account (Connect). */
  account?: string;
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Test helper + the exact algorithm Stripe uses: `t=<ts>,v1=<hmac(ts.body)>`. */
export async function signStripePayload(secret: string, rawBody: string, timestampSec: number): Promise<string> {
  const v1 = await hmacSha256Hex(secret, `${timestampSec}.${rawBody}`);
  return `t=${timestampSec},v1=${v1}`;
}

/**
 * Verify `Stripe-Signature` over the RAW body and parse the event. null = reject
 * (401): bad/missing header, signature mismatch, timestamp outside the replay
 * window, or a body that is not a Stripe event. Several `v1` entries are
 * accepted (Stripe sends more than one during a secret rotation).
 */
export async function verifyStripeEvent(
  rawBody: string,
  signatureHeader: string | null | undefined,
  webhookSecret: string,
  nowSec = Math.floor(Date.now() / 1000),
  toleranceSec = SIGNATURE_TOLERANCE_SEC,
): Promise<StripeEvent | null> {
  if (!signatureHeader) return null;
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of signatureHeader.split(',')) {
    const [k, v] = part.trim().split('=', 2);
    if (k === 't' && v && /^\d+$/.test(v)) timestamp = Number(v);
    else if (k === 'v1' && v) signatures.push(v.toLowerCase());
  }
  if (timestamp === null || signatures.length === 0) return null;
  if (Math.abs(nowSec - timestamp) > toleranceSec) return null;

  const expected = await hmacSha256Hex(webhookSecret, `${timestamp}.${rawBody}`);
  if (!signatures.some((s) => timingSafeEqualHex(s, expected))) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return null;
  }
  const e = parsed as Partial<StripeEvent> | null;
  if (!e || typeof e.id !== 'string' || typeof e.type !== 'string' || !e.data || typeof e.data !== 'object') return null;
  const object = (e.data as { object?: unknown }).object;
  if (!object || typeof object !== 'object') return null;
  const account = typeof (e as { account?: unknown }).account === 'string' ? (e as { account: string }).account : undefined;
  return { id: e.id, type: e.type, data: { object: object as Record<string, unknown> }, ...(account ? { account } : {}) };
}
