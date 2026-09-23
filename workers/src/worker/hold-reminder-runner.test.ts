import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TenantContext } from '../core/types.js';

vi.mock('../db/queries.js');
vi.mock('./system-message.js');

import * as q from '../db/queries.js';
import { sendSystemMessage } from './system-message.js';
import { runHoldReminders } from './hold-reminder-runner.js';

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
  checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_1',
  stripeSessionId: 'cs_1',
  stripeAccount: null,
  shortCode: 'abcdefghjk',
  dueAt: '2026-09-23T15:00:00.000Z',
  channel: 'whatsapp',
  contactPhone: '+5266412345',
  ghlLocationId: 'loc1',
  ...o,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(q.claimDueHoldReminders).mockResolvedValue([claimed()]);
  vi.mocked(q.loadTenantConfig).mockResolvedValue(tenant);
  vi.mocked(q.logBotEvent).mockResolvedValue(undefined);
  vi.mocked(q.getConversationPersona).mockResolvedValue({ leadTimezone: null } as never);
  vi.mocked(sendSystemMessage).mockResolvedValue('sent');
});

describe('runHoldReminders (0065)', () => {
  it('nothing due → zeros, nothing sent', async () => {
    vi.mocked(q.claimDueHoldReminders).mockResolvedValue([]);
    expect(await runHoldReminders()).toEqual({ claimed: 0, sent: 0, skipped: 0 });
    expect(sendSystemMessage).not.toHaveBeenCalled();
  });

  it('sends the fixed reminder with the SHORT link and logs hold_reminder_sent', async () => {
    const res = await runHoldReminders();
    expect(res).toEqual({ claimed: 1, sent: 1, skipped: 0 });
    const call = vi.mocked(sendSystemMessage).mock.calls[0]![0];
    expect(call.tag).toBe('hold-reminder');
    expect(call.text).toContain('sigue apartado hasta el');
    expect(call.text.endsWith('\nhttps://thebotcrew-agents.floral-credit-be7e.workers.dev/p/abcdefghjk')).toBe(true);
    expect(call.text).not.toContain('checkout.stripe.com');
    expect(q.logBotEvent).toHaveBeenCalledWith('client1', 'conv1', 'hold_reminder_sent', expect.objectContaining({ holdId: 'hold-1', outcome: 'sent' }));
  });

  it('a hold born before 0063 (no code) repeats the Stripe URL instead', async () => {
    vi.mocked(q.claimDueHoldReminders).mockResolvedValue([claimed({ shortCode: null })]);
    await runHoldReminders();
    expect(vi.mocked(sendSystemMessage).mock.calls[0]![0].text).toContain('https://checkout.stripe.com/c/pay/cs_1');
  });

  it('suppressed by a human takeover → counted skipped, still logged with its outcome', async () => {
    vi.mocked(sendSystemMessage).mockResolvedValue('suppressed');
    expect(await runHoldReminders()).toEqual({ claimed: 1, sent: 0, skipped: 1 });
    expect(q.logBotEvent).toHaveBeenCalledWith('client1', 'conv1', 'hold_reminder_sent', expect.objectContaining({ outcome: 'suppressed' }));
  });

  it('inactive tenant or no channel → skipped, nothing sent', async () => {
    vi.mocked(q.claimDueHoldReminders).mockResolvedValue([claimed({ ghlLocationId: null }), claimed({ id: 'hold-2', channel: null })]);
    expect(await runHoldReminders()).toEqual({ claimed: 2, sent: 0, skipped: 2 });
    expect(sendSystemMessage).not.toHaveBeenCalled();
  });

  it('a throw on one reminder does not stop the next', async () => {
    vi.mocked(q.claimDueHoldReminders).mockResolvedValue([claimed(), claimed({ id: 'hold-2' })]);
    vi.mocked(sendSystemMessage).mockRejectedValueOnce(new Error('ghl down')).mockResolvedValueOnce('sent');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await runHoldReminders()).toEqual({ claimed: 2, sent: 1, skipped: 1 });
    spy.mockRestore();
  });
});
