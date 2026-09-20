import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { TenantContext, TurnContext } from '../../../core/types.js';
import type { FrontDeskConfig } from '../config.js';

vi.mock('../../../db/queries.js');
vi.mock('../../../payments/stripe.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../payments/stripe.js')>()),
  getStripeEnv: vi.fn(),
  createCheckoutSession: vi.fn(),
  expireCheckoutSession: vi.fn(),
}));

import * as q from '../../../db/queries.js';
import { createCheckoutSession, expireCheckoutSession, getStripeEnv } from '../../../payments/stripe.js';
import { PAYMENT_PENDING_TAG, PAYMENT_REVIEW_TAG } from '../../../ghl/tags.js';
import type { GhlClient } from '../../../ghl/client.js';
import { parseFrontDeskConfig } from '../config.js';
import { describeHoldForModel, formatHoldAmount, openBookingHold, releaseBookingHold, workerBaseUrl } from './booking-hold.js';

const tenant = { tenantId: 't1', clientId: 'client1', ghlLocationId: 'loc1' } as unknown as TenantContext;
const turn = { ghlContactId: 'c1', ghlConversationId: 'conv1', channel: 'whatsapp' } as TurnContext;
const ghl = { addContactTags: vi.fn(), removeContactTags: vi.fn() } as unknown as GhlClient & {
  addContactTags: ReturnType<typeof vi.fn>;
  removeContactTags: ReturnType<typeof vi.fn>;
};

const NOW = Date.parse('2026-09-20T18:00:00Z');
const START = '2026-09-23T17:00:00.000Z';

function config(payment: Record<string, unknown> | null = { amount: 500 }, services: unknown[] = [{ name: 'Consulta' }]): FrontDeskConfig {
  return parseFrontDeskConfig({
    businessName: 'Clínica Demo',
    timezone: 'America/Mexico_City',
    tone: null,
    services,
    hours: {},
    calendars: { Consulta: 'cal1' },
    faq: [],
    promptOverrides: {},
    bookingPayment: payment,
  });
}

const env = { secretKey: 'sk_test', webhookSecret: 'whsec', mode: 'test' as const };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getStripeEnv).mockReturnValue(env);
  vi.mocked(createCheckoutSession).mockResolvedValue({ id: 'cs_1', url: 'https://checkout.stripe.com/c/pay/cs_1', expiresAt: 0 });
  vi.mocked(expireCheckoutSession).mockResolvedValue('expired');
  vi.mocked(q.createBookingHold).mockResolvedValue('hold-1');
  vi.mocked(q.logBotEvent).mockResolvedValue(undefined);
  vi.mocked(q.finishHold).mockResolvedValue(true);
  ghl.addContactTags.mockResolvedValue(undefined);
  ghl.removeContactTags.mockResolvedValue(undefined);
});

describe('formatHoldAmount', () => {
  it('whole pesos without decimals, fractions with two, currency code upper', () => {
    expect(formatHoldAmount(50000, 'mxn')).toBe('$500 MXN');
    expect(formatHoldAmount(125050, 'mxn')).toBe('$1,250.50 MXN');
  });
});

describe('workerBaseUrl', () => {
  const saved = process.env.WORKER_URL;
  afterEach(() => {
    if (saved === undefined) delete process.env.WORKER_URL;
    else process.env.WORKER_URL = saved;
  });
  it('uses WORKER_URL without a trailing slash, else the known workers.dev base', () => {
    process.env.WORKER_URL = 'https://x.example/';
    expect(workerBaseUrl()).toBe('https://x.example');
    delete process.env.WORKER_URL;
    expect(workerBaseUrl()).toMatch(/^https:\/\/thebotcrew-agents\./);
  });
});

describe('openBookingHold', () => {
  const open = (cfg = config()) =>
    openBookingHold({ tenant, turn, config: cfg, ghl, ghlAppointmentId: 'appt1', serviceName: 'Consulta', startTime: START, frameTz: cfg.timezone, now: NOW });

  it('creates a 24h card session for the tenant amount, records the hold, tags pago-pendiente, returns link + labels', async () => {
    const res = await open();
    expect(res).toMatchObject({ checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_1', amountLabel: '$500 MXN' });
    expect('dueLabel' in res && res.dueLabel).toMatch(/lunes, 21 de septiembre/);

    expect(createCheckoutSession).toHaveBeenCalledWith(
      env,
      expect.objectContaining({
        amountCents: 50000,
        currency: 'mxn',
        productName: 'Apartado — Consulta · Clínica Demo',
        idempotencyKey: 'hold:appt1',
        metadata: expect.objectContaining({ ghlAppointmentId: 'appt1', clientId: 'client1', ghlConversationId: 'conv1' }),
      }),
    );
    const call = vi.mocked(createCheckoutSession).mock.calls[0]![1];
    expect(call.expiresAt.getTime()).toBe(NOW + 24 * 3600_000);
    expect(call.successUrl).toMatch(/\/pay\/ok$/);

    expect(q.createBookingHold).toHaveBeenCalledWith(
      expect.objectContaining({
        p_ghl_appointment_id: 'appt1',
        p_amount_cents: 50000,
        p_currency: 'mxn',
        p_stripe_session_id: 'cs_1',
        p_checkout_url: 'https://checkout.stripe.com/c/pay/cs_1',
        p_due_at: new Date(NOW + 24 * 3600_000).toISOString(),
      }),
    );
    expect(ghl.addContactTags).toHaveBeenCalledWith('c1', [PAYMENT_PENDING_TAG]);
    expect(q.logBotEvent).toHaveBeenCalledWith('client1', 'conv1', 'hold_created', expect.objectContaining({ amountCents: 50000 }));
  });

  it('a per-service deposit wins over the tenant amount; hold_hours and statement suffix ride along', async () => {
    const cfg = config({ amount: 500, hold_hours: 48, statement_suffix: 'DR VALDIVIA' }, [{ name: 'Consulta', deposit: 250 }]);
    const res = await open(cfg);
    expect(res).toMatchObject({ amountLabel: '$250 MXN' });
    const call = vi.mocked(createCheckoutSession).mock.calls[0]![1];
    expect(call.amountCents).toBe(25000);
    expect(call.statementSuffix).toBe('DR VALDIVIA');
    expect(call.expiresAt.getTime()).toBe(NOW + 48 * 3600_000);
  });

  it('Stripe not configured → error, nothing written, loud event', async () => {
    vi.mocked(getStripeEnv).mockReturnValue(null);
    const res = await open();
    expect(res).toEqual({ error: 'stripe_not_configured' });
    expect(createCheckoutSession).not.toHaveBeenCalled();
    expect(q.createBookingHold).not.toHaveBeenCalled();
  });

  it('Stripe rejects the session → error + payment_error event, no hold row', async () => {
    vi.mocked(createCheckoutSession).mockRejectedValue(new Error('[stripe] 400 nope'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await open();
    expect(res).toEqual({ error: 'checkout_session_failed' });
    expect(q.createBookingHold).not.toHaveBeenCalled();
    expect(q.logBotEvent).toHaveBeenCalledWith('client1', 'conv1', 'payment_error', expect.objectContaining({ stage: 'create_checkout_session' }));
    spy.mockRestore();
  });

  it('the hold row fails after the session exists → the orphan session is expired, error returned', async () => {
    vi.mocked(q.createBookingHold).mockRejectedValue(new Error('db down'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await open();
    expect(res).toEqual({ error: 'hold_row_failed' });
    expect(expireCheckoutSession).toHaveBeenCalledWith(env, 'cs_1');
    expect(ghl.addContactTags).not.toHaveBeenCalled();
    expect(q.logBotEvent).toHaveBeenCalledWith('client1', 'conv1', 'payment_error', expect.objectContaining({ stage: 'create_hold_row', stripeSessionId: 'cs_1' }));
    spy.mockRestore();
  });

  it('a tag failure never fails the hold', async () => {
    ghl.addContactTags.mockRejectedValue(new Error('ghl down'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await open();
    expect('checkoutUrl' in res).toBe(true);
    spy.mockRestore();
  });
});

describe('releaseBookingHold', () => {
  const hold = (status: string) => ({
    id: 'hold-1', ghlAppointmentId: 'appt1', stripeSessionId: 'cs_1', checkoutUrl: 'u', amountCents: 50000, currency: 'mxn', status, dueAt: '2026-09-21T18:00:00Z', paidAt: null,
  });
  const release = () => releaseBookingHold({ tenant, ghl, ghlContactId: 'c1', ghlConversationId: 'conv1', ghlAppointmentId: 'appt1' });

  it('no hold → none, nothing touched', async () => {
    vi.mocked(q.getBookingHold).mockResolvedValue(null);
    expect(await release()).toBe('none');
    expect(q.finishHold).not.toHaveBeenCalled();
  });

  it('pending → cancelled: session expired, tag removed, event logged', async () => {
    vi.mocked(q.getBookingHold).mockResolvedValue(hold('pending') as never);
    expect(await release()).toBe('released');
    expect(q.finishHold).toHaveBeenCalledWith('hold-1', 'cancelled');
    expect(expireCheckoutSession).toHaveBeenCalledWith(env, 'cs_1');
    expect(ghl.removeContactTags).toHaveBeenCalledWith('c1', [PAYMENT_PENDING_TAG]);
    expect(q.logBotEvent).toHaveBeenCalledWith('client1', 'conv1', 'hold_released', expect.objectContaining({ status: 'pending' }));
  });

  it('paid → left as is, flagged pago-revisar, no Stripe call', async () => {
    vi.mocked(q.getBookingHold).mockResolvedValue(hold('paid') as never);
    expect(await release()).toBe('paid');
    expect(q.finishHold).not.toHaveBeenCalled();
    expect(expireCheckoutSession).not.toHaveBeenCalled();
    expect(ghl.addContactTags).toHaveBeenCalledWith('c1', [PAYMENT_REVIEW_TAG]);
    expect(q.logBotEvent).toHaveBeenCalledWith('client1', 'conv1', 'hold_released', expect.objectContaining({ status: 'paid', review: true }));
  });

  it('the race: a payment lands between the read and the cancel → re-read as paid', async () => {
    vi.mocked(q.getBookingHold).mockResolvedValueOnce(hold('pending') as never).mockResolvedValueOnce(hold('paid') as never);
    vi.mocked(q.finishHold).mockResolvedValue(false);
    expect(await release()).toBe('paid');
    expect(expireCheckoutSession).not.toHaveBeenCalled();
    expect(ghl.addContactTags).toHaveBeenCalledWith('c1', [PAYMENT_REVIEW_TAG]);
  });

  it('expired / cancelled → none (already closed)', async () => {
    vi.mocked(q.getBookingHold).mockResolvedValue(hold('expired') as never);
    expect(await release()).toBe('none');
    expect(q.finishHold).not.toHaveBeenCalled();
  });
});

describe('describeHoldForModel', () => {
  const tz = 'America/Mexico_City';
  const base = { checkoutUrl: 'https://pay/x', amountCents: 50000, currency: 'mxn', dueAt: '2026-09-21T18:00:00Z' };
  it('pending → link, amount, deadline, and the "don\'t assume paid" rule', () => {
    const s = describeHoldForModel({ ...base, status: 'pending' }, tz, tz);
    expect(s).toContain('APARTADA');
    expect(s).toContain('$500 MXN');
    expect(s).toContain('https://pay/x');
    expect(s).toMatch(/lunes, 21 de septiembre/);
    expect(s).toContain('no la des por pagada');
  });
  it('paid → confirmed; paid_late → under review; expired → released; none → empty', () => {
    expect(describeHoldForModel({ ...base, status: 'paid' }, tz, tz)).toContain('PAGADA');
    expect(describeHoldForModel({ ...base, status: 'paid_late' }, tz, tz)).toContain('revisando');
    expect(describeHoldForModel({ ...base, status: 'expired' }, tz, tz)).toContain('se liberó');
    expect(describeHoldForModel(null, tz, tz)).toBe('');
  });
});
