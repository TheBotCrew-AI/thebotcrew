import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  CHECKOUT_MAX_EXPIRY_MS,
  CHECKOUT_MIN_EXPIRY_MS,
  clampCheckoutExpiry,
  createCheckoutSession,
  expireCheckoutSession,
  getStripeEnv,
  signStripePayload,
  verifyStripeEvent,
} from './stripe.js';

const env = { secretKey: 'sk_test_123', webhookSecret: 'whsec_test', mode: 'test' as const };
const NOW = Date.parse('2026-09-20T18:00:00Z');

describe('getStripeEnv', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('needs BOTH secrets — a half-configured Stripe is off, not half on', () => {
    delete process.env.STRIPE_MODE;
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_WEBHOOK_SECRET;
    expect(getStripeEnv()).toBeNull();
    process.env.STRIPE_SECRET_KEY = 'sk_live_x';
    expect(getStripeEnv()).toBeNull();
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_x';
    expect(getStripeEnv()).toEqual({ secretKey: 'sk_live_x', webhookSecret: 'whsec_x', mode: 'live' });
  });

  it('STRIPE_MODE=test reads the *_TEST_MODE pair and ignores the live one', () => {
    process.env.STRIPE_MODE = 'test';
    process.env.STRIPE_SECRET_KEY = 'sk_live_x';
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_live';
    delete process.env.STRIPE_SECRET_KEY_TEST_MODE;
    delete process.env.STRIPE_WEBHOOK_SECRET_TEST_MODE;
    expect(getStripeEnv()).toBeNull();
    process.env.STRIPE_SECRET_KEY_TEST_MODE = 'sk_test_x';
    process.env.STRIPE_WEBHOOK_SECRET_TEST_MODE = 'whsec_test';
    expect(getStripeEnv()).toEqual({ secretKey: 'sk_test_x', webhookSecret: 'whsec_test', mode: 'test' });
    process.env.STRIPE_MODE = 'live';
    expect(getStripeEnv()).toEqual({ secretKey: 'sk_live_x', webhookSecret: 'whsec_live', mode: 'live' });
  });
});

describe('clampCheckoutExpiry', () => {
  it('keeps a 24h hold as-is, in unix seconds', () => {
    const wanted = new Date(NOW + CHECKOUT_MAX_EXPIRY_MS);
    expect(clampCheckoutExpiry(wanted, NOW)).toBe(Math.floor(wanted.getTime() / 1000));
  });
  it('caps a 48h hold at Stripe\'s 24h maximum — the cron owns the rest of the wait', () => {
    expect(clampCheckoutExpiry(new Date(NOW + 48 * 3600_000), NOW)).toBe(Math.floor((NOW + CHECKOUT_MAX_EXPIRY_MS) / 1000));
  });
  it('floors a too-short expiry at 30 minutes', () => {
    expect(clampCheckoutExpiry(new Date(NOW + 60_000), NOW)).toBe(Math.floor((NOW + CHECKOUT_MIN_EXPIRY_MS) / 1000));
  });
});

describe('createCheckoutSession', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  const input = {
    amountCents: 50000,
    currency: 'MXN',
    productName: 'Apartado — Consulta',
    expiresAt: new Date(NOW + 24 * 3600_000),
    metadata: { ghlAppointmentId: 'appt1', clientId: 'c1' },
    statementSuffix: 'DR VALDIVIA',
    idempotencyKey: 'hold:appt1',
    successUrl: 'https://w/pay/ok',
    cancelUrl: 'https://w/pay/cancel',
    now: NOW,
  };

  it('POSTs a card-only, single-payment, es-419 session with the idempotency key and returns the url', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ id: 'cs_1', url: 'https://checkout.stripe.com/c/pay/cs_1', expires_at: 1 }), { status: 200 }));
    const s = await createCheckoutSession(env, input);
    expect(s).toEqual({ id: 'cs_1', url: 'https://checkout.stripe.com/c/pay/cs_1', expiresAt: 1 });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.stripe.com/v1/checkout/sessions');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer sk_test_123');
    expect(headers['Idempotency-Key']).toBe('hold:appt1');
    const body = new URLSearchParams(String(init.body));
    expect(body.get('mode')).toBe('payment');
    expect(body.get('line_items[0][price_data][currency]')).toBe('mxn');
    expect(body.get('line_items[0][price_data][unit_amount]')).toBe('50000');
    expect(body.get('line_items[0][price_data][product_data][name]')).toBe('Apartado — Consulta');
    expect(body.get('payment_method_types[0]')).toBe('card');
    expect(body.get('locale')).toBe('es-419');
    expect(body.get('expires_at')).toBe(String(Math.floor((NOW + 24 * 3600_000) / 1000)));
    expect(body.get('payment_intent_data[statement_descriptor_suffix]')).toBe('DR VALDIVIA');
    expect(body.get('metadata[ghlAppointmentId]')).toBe('appt1');
    expect(body.get('client_reference_id')).toBe('appt1');
    expect(body.get('success_url')).toBe('https://w/pay/ok');
  });

  it('throws with the Stripe body on a non-2xx (the tool then cancels the booking)', async () => {
    fetchMock.mockResolvedValue(new Response('{"error":{"message":"No such price"}}', { status: 400 }));
    await expect(createCheckoutSession(env, input)).rejects.toThrow(/400.*No such price/);
  });

  it('throws when the session comes back without a url', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ id: 'cs_1', url: null }), { status: 200 }));
    await expect(createCheckoutSession(env, input)).rejects.toThrow(/no url/);
  });
});

describe('expireCheckoutSession', () => {
  const fetchMock = vi.fn();
  beforeEach(() => vi.stubGlobal('fetch', fetchMock));
  afterEach(() => vi.unstubAllGlobals());

  it('200 → expired; 400 (already paid/expired) → already_closed, not an error', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));
    expect(await expireCheckoutSession(env, 'cs_1')).toBe('expired');
    fetchMock.mockResolvedValueOnce(new Response('{"error":{}}', { status: 400 }));
    expect(await expireCheckoutSession(env, 'cs_1')).toBe('already_closed');
    expect(fetchMock.mock.calls[0]![0]).toBe('https://api.stripe.com/v1/checkout/sessions/cs_1/expire');
  });

  it('a 401 (bad key) still throws — that one must be seen', async () => {
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 401 }));
    await expect(expireCheckoutSession(env, 'cs_1')).rejects.toThrow(/401/);
  });
});

describe('verifyStripeEvent', () => {
  const body = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed', data: { object: { id: 'cs_1', payment_status: 'paid' } } });
  const ts = 1_800_000_000;

  it('accepts a correctly signed body inside the tolerance window', async () => {
    const header = await signStripePayload('whsec_test', body, ts);
    const evt = await verifyStripeEvent(body, header, 'whsec_test', ts + 10);
    expect(evt?.type).toBe('checkout.session.completed');
    expect(evt?.data.object.id).toBe('cs_1');
  });

  it('accepts one valid v1 among several (secret rotation)', async () => {
    const good = await signStripePayload('whsec_test', body, ts);
    const header = `${good},v1=${'0'.repeat(64)}`;
    expect(await verifyStripeEvent(body, header, 'whsec_test', ts)).not.toBeNull();
  });

  it('rejects a wrong secret, a tampered body, a stale timestamp, and a missing header', async () => {
    const header = await signStripePayload('whsec_test', body, ts);
    expect(await verifyStripeEvent(body, header, 'whsec_other', ts)).toBeNull();
    expect(await verifyStripeEvent(body.replace('cs_1', 'cs_2'), header, 'whsec_test', ts)).toBeNull();
    expect(await verifyStripeEvent(body, header, 'whsec_test', ts + 301)).toBeNull();
    expect(await verifyStripeEvent(body, null, 'whsec_test', ts)).toBeNull();
    expect(await verifyStripeEvent(body, 't=abc,v1=zz', 'whsec_test', ts)).toBeNull();
  });

  it('rejects a signed body that is not an event', async () => {
    const junk = '{"hello":1}';
    const header = await signStripePayload('whsec_test', junk, ts);
    expect(await verifyStripeEvent(junk, header, 'whsec_test', ts)).toBeNull();
  });
});
