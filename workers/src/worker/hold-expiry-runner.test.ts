import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TenantContext } from '../core/types.js';

vi.mock('../db/queries.js');
vi.mock('./system-message.js');
vi.mock('../payments/stripe.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../payments/stripe.js')>()),
  getStripeEnv: vi.fn(),
  expireCheckoutSession: vi.fn(),
}));
const ghl = { cancelAppointment: vi.fn(), addContactTags: vi.fn(), removeContactTags: vi.fn() };
vi.mock('../ghl/client.js', () => ({ GhlClient: vi.fn(() => ghl) }));

import * as q from '../db/queries.js';
import { expireCheckoutSession, getStripeEnv } from '../payments/stripe.js';
import { CANCELLED_APPOINTMENT_TAG, HOLD_EXPIRED_TAG, PAYMENT_PENDING_TAG } from '../ghl/tags.js';
import { sendSystemMessage } from './system-message.js';
import { runExpiredHolds } from './hold-expiry-runner.js';

const tenant = {
  tenantId: 't1',
  clientId: 'client1',
  ghlLocationId: 'loc1',
  config: { businessName: 'Clínica Demo', timezone: 'America/Mexico_City', leadTimezoneEnabled: false },
} as unknown as TenantContext;

const claimed = (o: Record<string, unknown> = {}) => ({
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
  stripeSessionId: 'cs_1',
  dueAt: '2026-09-21T18:00:00Z',
  channel: 'whatsapp',
  contactPhone: '+5266412345',
  ghlLocationId: 'loc1',
  ...o,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(q.claimExpiredHolds).mockResolvedValue([claimed()]);
  vi.mocked(q.loadTenantConfig).mockResolvedValue(tenant);
  vi.mocked(q.finishHold).mockResolvedValue(true);
  vi.mocked(q.logAppointment).mockResolvedValue({ appointmentId: 'row' });
  vi.mocked(q.logBotEvent).mockResolvedValue(undefined);
  vi.mocked(q.reactivateConversation).mockResolvedValue(undefined);
  vi.mocked(q.getConversationPersona).mockResolvedValue({ leadTimezone: null } as never);
  vi.mocked(getStripeEnv).mockReturnValue({ secretKey: 'sk', webhookSecret: 'wh', mode: 'test' });
  vi.mocked(expireCheckoutSession).mockResolvedValue('expired');
  vi.mocked(sendSystemMessage).mockResolvedValue('sent');
  ghl.cancelAppointment.mockResolvedValue(undefined);
  ghl.addContactTags.mockResolvedValue(undefined);
  ghl.removeContactTags.mockResolvedValue(undefined);
});

describe('runExpiredHolds', () => {
  it('nothing due → zeros, no calls', async () => {
    vi.mocked(q.claimExpiredHolds).mockResolvedValue([]);
    expect(await runExpiredHolds()).toEqual({ claimed: 0, expired: 0, retried: 0, raced: 0 });
    expect(ghl.cancelAppointment).not.toHaveBeenCalled();
  });

  it('happy path: GHL cancel → Stripe expire → expired → appointments row → tags → event → reopen → message', async () => {
    const res = await runExpiredHolds();
    expect(res).toEqual({ claimed: 1, expired: 1, retried: 0, raced: 0 });
    expect(ghl.cancelAppointment).toHaveBeenCalledWith('appt1');
    expect(expireCheckoutSession).toHaveBeenCalledWith(expect.anything(), 'cs_1');
    expect(q.finishHold).toHaveBeenCalledWith('hold-1', 'expired');
    expect(q.logAppointment).toHaveBeenCalledWith(expect.objectContaining({ p_action: 'cancelled', p_source: 'hold-expiry', p_ghl_appointment_id: 'appt1' }));
    expect(ghl.addContactTags).toHaveBeenCalledWith('c1', [HOLD_EXPIRED_TAG, CANCELLED_APPOINTMENT_TAG]);
    expect(ghl.removeContactTags).toHaveBeenCalledWith('c1', [PAYMENT_PENDING_TAG]);
    expect(q.logBotEvent).toHaveBeenCalledWith('client1', 'conv1', 'hold_expired', expect.objectContaining({ holdId: 'hold-1' }));
    expect(q.reactivateConversation).toHaveBeenCalledWith('conv1');
    expect(sendSystemMessage).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'whatsapp', text: expect.stringMatching(/venció el plazo.*miércoles, 23 de septiembre.*se liberó/s) }),
    );
    // The cancel happens BEFORE the hold is marked expired: a stuck cancel must not read as done.
    const cancelAt = ghl.cancelAppointment.mock.invocationCallOrder[0]!;
    const finishAt = vi.mocked(q.finishHold).mock.invocationCallOrder[0]!;
    expect(cancelAt).toBeLessThan(finishAt);
  });

  it('GHL cancel fails → hold back to pending (retry next tick), loud payment_error, nothing else', async () => {
    ghl.cancelAppointment.mockRejectedValue(new Error('500'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await runExpiredHolds();
    expect(res).toEqual({ claimed: 1, expired: 0, retried: 1, raced: 0 });
    expect(q.finishHold).toHaveBeenCalledWith('hold-1', 'pending');
    expect(q.logBotEvent).toHaveBeenCalledWith('client1', 'conv1', 'payment_error', expect.objectContaining({ stage: 'expire_cancel_appointment' }));
    expect(expireCheckoutSession).not.toHaveBeenCalled();
    expect(sendSystemMessage).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('the race: paid while expiring (finishHold false) → counted raced, no tags/message, left to review', async () => {
    vi.mocked(q.finishHold).mockResolvedValue(false);
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await runExpiredHolds();
    expect(res).toEqual({ claimed: 1, expired: 0, retried: 0, raced: 1 });
    expect(q.logAppointment).not.toHaveBeenCalled();
    expect(ghl.addContactTags).not.toHaveBeenCalled();
    expect(sendSystemMessage).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('inactive tenant → expired without GHL', async () => {
    vi.mocked(q.claimExpiredHolds).mockResolvedValue([claimed({ ghlLocationId: null })]);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await runExpiredHolds();
    expect(res.expired).toBe(1);
    expect(ghl.cancelAppointment).not.toHaveBeenCalled();
    expect(q.finishHold).toHaveBeenCalledWith('hold-1', 'expired');
    spy.mockRestore();
  });

  it('Stripe not configured → still releases (the session dies on its own expiry)', async () => {
    vi.mocked(getStripeEnv).mockReturnValue(null);
    const res = await runExpiredHolds();
    expect(res.expired).toBe(1);
    expect(expireCheckoutSession).not.toHaveBeenCalled();
  });

  it('an unexpected throw mid-way puts the hold back to pending and continues with the next', async () => {
    vi.mocked(q.claimExpiredHolds).mockResolvedValue([claimed(), claimed({ id: 'hold-2', ghlAppointmentId: 'appt2' })]);
    vi.mocked(q.logBotEvent).mockRejectedValueOnce(new Error('boom'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await runExpiredHolds();
    expect(res.claimed).toBe(2);
    expect(res.retried + res.expired).toBe(2);
    expect(q.finishHold).toHaveBeenCalledWith('hold-1', 'pending');
    spy.mockRestore();
  });
});
