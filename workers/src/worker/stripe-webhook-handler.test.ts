import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TenantContext } from '../core/types.js';

vi.mock('../db/queries.js');
vi.mock('../meta/capi.js');
vi.mock('./system-message.js');
const ghl = { updateAppointmentStatus: vi.fn(), addContactTags: vi.fn(), removeContactTags: vi.fn() };
vi.mock('../ghl/client.js', () => ({ GhlClient: vi.fn(() => ghl) }));

import * as q from '../db/queries.js';
import { queueCapiEvent } from '../meta/capi.js';
import { signStripePayload } from '../payments/stripe.js';
import { PAID_APPOINTMENT_TAG, PAYMENT_PENDING_TAG, PAYMENT_REVIEW_TAG } from '../ghl/tags.js';
import { sendSystemMessage } from './system-message.js';
import { handleStripeWebhook, processStripeEvent } from './stripe-webhook-handler.js';

const tenant = {
  tenantId: 't1',
  clientId: 'client1',
  ghlLocationId: 'loc1',
  metaCapi: null,
  config: { businessName: 'Clínica Demo', timezone: 'America/Mexico_City', leadTimezoneEnabled: false },
} as unknown as TenantContext;

const NOW = Date.parse('2026-09-20T18:00:00Z');
const SECRET = 'whsec_test';

const settled = (outcome: 'paid' | 'paid_late') => ({
  outcome,
  id: 'hold-1',
  clientId: 'client1',
  ghlConversationId: 'conv1',
  ghlContactId: 'c1',
  ghlAppointmentId: 'appt1',
  serviceType: 'Consulta',
  appointmentDatetime: '2026-09-23T17:00:00.000Z',
  amountCents: 50000,
  currency: 'mxn',
  checkoutUrl: 'https://pay/x',
  dueAt: '2026-09-21T18:00:00Z',
  channel: 'whatsapp',
  contactPhone: '+5266412345',
  ghlLocationId: 'loc1',
});

const event = (o: Record<string, unknown> = {}, type = 'checkout.session.completed') => ({
  id: 'evt_1',
  type,
  data: { object: { id: 'cs_1', payment_status: 'paid', payment_intent: 'pi_1', ...o } },
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(q.loadTenantConfig).mockResolvedValue(tenant);
  vi.mocked(q.settleHoldPayment).mockResolvedValue(settled('paid'));
  vi.mocked(q.logBotEvent).mockResolvedValue(undefined);
  vi.mocked(q.getConversationPersona).mockResolvedValue({ leadTimezone: null } as never);
  vi.mocked(queueCapiEvent).mockResolvedValue(undefined);
  vi.mocked(sendSystemMessage).mockResolvedValue('sent');
  ghl.updateAppointmentStatus.mockResolvedValue(undefined);
  ghl.addContactTags.mockResolvedValue(undefined);
  ghl.removeContactTags.mockResolvedValue(undefined);
});

describe('handleStripeWebhook — signature (fails closed)', () => {
  const body = JSON.stringify(event());

  it('no secret configured → 401 even with a valid signature', async () => {
    const sig = await signStripePayload(SECRET, body, Math.floor(NOW / 1000));
    const res = await handleStripeWebhook(body, sig, undefined, NOW);
    expect(res.status).toBe(401);
    expect(q.settleHoldPayment).not.toHaveBeenCalled();
  });

  it('bad signature → 401, nothing settled', async () => {
    const sig = await signStripePayload('whsec_other', body, Math.floor(NOW / 1000));
    expect((await handleStripeWebhook(body, sig, SECRET, NOW)).status).toBe(401);
    expect((await handleStripeWebhook(body, null, SECRET, NOW)).status).toBe(401);
    expect(q.settleHoldPayment).not.toHaveBeenCalled();
  });

  it('valid signature → the event is processed', async () => {
    const sig = await signStripePayload(SECRET, body, Math.floor(NOW / 1000));
    const res = await handleStripeWebhook(body, sig, SECRET, NOW);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ settled: 'paid' });
  });
});

describe('processStripeEvent — paid', () => {
  it('settles, confirms the GHL event, swaps tags, logs booking_paid, fires a Purchase with the real value, tells the lead', async () => {
    const res = await processStripeEvent(event(), NOW);
    expect(res).toMatchObject({ status: 200, body: { settled: 'paid', holdId: 'hold-1' } });
    expect(q.settleHoldPayment).toHaveBeenCalledWith('cs_1', 'pi_1');
    expect(ghl.updateAppointmentStatus).toHaveBeenCalledWith('appt1', 'confirmed');
    expect(ghl.addContactTags).toHaveBeenCalledWith('c1', [PAID_APPOINTMENT_TAG]);
    expect(ghl.removeContactTags).toHaveBeenCalledWith('c1', [PAYMENT_PENDING_TAG]);
    expect(q.logBotEvent).toHaveBeenCalledWith('client1', 'conv1', 'booking_paid', expect.objectContaining({ amountCents: 50000, stripeEventId: 'evt_1' }));
    expect(queueCapiEvent).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'appointment_paid', ghlConversationId: 'conv1', value: { amount: 500, currency: 'mxn' } }),
    );
    expect(sendSystemMessage).toHaveBeenCalledWith(
      expect.objectContaining({ ghlConversationId: 'conv1', channel: 'whatsapp', text: expect.stringMatching(/recibimos tu pago.*confirmada.*miércoles, 23 de septiembre/s) }),
    );
  });

  it('the async-payment event is the same path', async () => {
    const res = await processStripeEvent(event({}, 'checkout.session.async_payment_succeeded'), NOW);
    expect(res.body).toMatchObject({ settled: 'paid' });
  });

  it('a GHL confirm failure is loud but the payment still counts (tags, event, message)', async () => {
    ghl.updateAppointmentStatus.mockRejectedValue(new Error('401'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await processStripeEvent(event(), NOW);
    expect(res.status).toBe(200);
    expect(q.logBotEvent).toHaveBeenCalledWith('client1', 'conv1', 'payment_error', expect.objectContaining({ stage: 'confirm_appointment' }));
    expect(q.logBotEvent).toHaveBeenCalledWith('client1', 'conv1', 'booking_paid', expect.anything());
    expect(ghl.addContactTags).toHaveBeenCalledWith('c1', [PAID_APPOINTMENT_TAG]);
    expect(sendSystemMessage).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('replay / unknown session (settle returns null) → 200 ignored, nothing touched', async () => {
    vi.mocked(q.settleHoldPayment).mockResolvedValue(null);
    const res = await processStripeEvent(event(), NOW);
    expect(res.body).toMatchObject({ ignored: 'no settleable hold' });
    expect(ghl.updateAppointmentStatus).not.toHaveBeenCalled();
    expect(sendSystemMessage).not.toHaveBeenCalled();
  });

  it('a tenant that went inactive → 200 with a warning + payment_error, no GHL', async () => {
    vi.mocked(q.loadTenantConfig).mockResolvedValue(null);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await processStripeEvent(event(), NOW);
    expect(res.body).toMatchObject({ settled: 'paid', warning: 'tenant unresolved' });
    expect(q.logBotEvent).toHaveBeenCalledWith('client1', 'conv1', 'payment_error', expect.objectContaining({ stage: 'resolve_tenant' }));
    expect(ghl.updateAppointmentStatus).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('processStripeEvent — paid_late', () => {
  it('does NOT reconfirm the cita: pago-revisar tag, booking_paid_late, the "a person will write" message', async () => {
    vi.mocked(q.settleHoldPayment).mockResolvedValue(settled('paid_late'));
    const res = await processStripeEvent(event(), NOW);
    expect(res.body).toMatchObject({ settled: 'paid_late' });
    expect(ghl.updateAppointmentStatus).not.toHaveBeenCalled();
    expect(ghl.addContactTags).toHaveBeenCalledWith('c1', [PAYMENT_REVIEW_TAG]);
    expect(q.logBotEvent).toHaveBeenCalledWith('client1', 'conv1', 'booking_paid_late', expect.objectContaining({ holdId: 'hold-1' }));
    expect(queueCapiEvent).not.toHaveBeenCalled();
    expect(sendSystemMessage).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringMatching(/después del plazo/) }));
  });
});

describe('processStripeEvent — ignored shapes', () => {
  it('other event types → 200 ignored', async () => {
    const res = await processStripeEvent(event({}, 'checkout.session.expired'), NOW);
    expect(res.body).toMatchObject({ ignored: 'event type' });
    expect(q.settleHoldPayment).not.toHaveBeenCalled();
  });

  it('completed but not paid (delayed method) → 200, waits for the async event', async () => {
    const res = await processStripeEvent(event({ payment_status: 'unpaid' }), NOW);
    expect(res.body).toMatchObject({ ignored: 'not paid yet' });
    expect(q.settleHoldPayment).not.toHaveBeenCalled();
  });

  it('no session id → 200 ignored', async () => {
    const res = await processStripeEvent(event({ id: undefined }), NOW);
    expect(res.body).toMatchObject({ ignored: 'no session id' });
  });
});
