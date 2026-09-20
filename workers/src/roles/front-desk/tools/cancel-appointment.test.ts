import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TenantContext, TurnContext } from '../../../core/types.js';

const ghl = { cancelAppointment: vi.fn(), getContactAppointments: vi.fn(), addContactTags: vi.fn() };
vi.mock('../../../ghl/client.js', () => ({ GhlClient: vi.fn(() => ghl) }));
vi.mock('../../../db/queries.js');

import * as q from '../../../db/queries.js';
import { cancelAppointmentTool } from './cancel-appointment.js';

const tenant = {
  tenantId: 't1',
  clientId: 'client1',
  ghlLocationId: 'loc1',
  config: { businessName: 'Demo', timezone: 'America/Mexico_City', tone: null, services: [], hours: {}, calendars: {}, faq: [], promptOverrides: {} },
} as unknown as TenantContext;
const turn = { ghlContactId: 'c1', ghlConversationId: 'conv1', channel: 'whatsapp' } as TurnContext;
const ctx = { requestContext: { get: (k: string) => (k === 'tenant' ? tenant : k === 'turn' ? turn : undefined) } };
const run = () =>
  (cancelAppointmentTool.execute as (i: Record<string, never>, c: typeof ctx) => Promise<{ cancelled: boolean; message: string }>)({}, ctx);

// Far future: the resolver only serves FUTURE store rows (0049) — a near date rots
// into the past and silently reroutes the test through the GHL fallback.
const appt = (o: Record<string, unknown> = {}) => ({ ghlAppointmentId: 'appt1', appointmentDatetime: '2099-07-10T17:00:00Z', serviceType: 'Consulta', action: 'booked', ...o });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(q.loadAppointmentLog).mockResolvedValue([appt()] as never);
  vi.mocked(q.logAppointment).mockResolvedValue({ appointmentId: 'a-uuid' } as never);
  vi.mocked(q.logBotEvent).mockResolvedValue(undefined);
  vi.mocked(q.reactivateConversation).mockResolvedValue(undefined);
  ghl.cancelAppointment.mockResolvedValue(undefined);
  ghl.getContactAppointments.mockResolvedValue([]);
  ghl.addContactTags.mockResolvedValue(undefined);
});

describe('cancelAppointment', () => {
  it('no active appointment → not cancelled, GHL never called', async () => {
    vi.mocked(q.loadAppointmentLog).mockResolvedValue([]);
    const res = await run();
    expect(res).toMatchObject({ cancelled: false });
    expect(ghl.cancelAppointment).not.toHaveBeenCalled();
  });

  it('already cancelled → treated as none', async () => {
    vi.mocked(q.loadAppointmentLog).mockResolvedValue([appt({ action: 'cancelled' })] as never);
    const res = await run();
    expect(res.cancelled).toBe(false);
    expect(ghl.cancelAppointment).not.toHaveBeenCalled();
  });

  it('active appointment → cancels in GHL, records it, reopens the conversation', async () => {
    const res = await run();
    expect(ghl.cancelAppointment).toHaveBeenCalledWith('appt1');
    expect(q.logAppointment).toHaveBeenCalledWith(expect.objectContaining({ p_action: 'cancelled', p_ghl_appointment_id: 'appt1' }));
    expect(q.reactivateConversation).toHaveBeenCalledWith('conv1');
    expect(res).toMatchObject({ cancelled: true });
  });

  it('store miss but GHL has an upcoming appointment (booked in GHL) → cancels it via GHL', async () => {
    vi.mocked(q.loadAppointmentLog).mockResolvedValue([]);
    const ghlTime = new Date(Date.now() + 20 * 86_400_000).toISOString();
    ghl.getContactAppointments.mockResolvedValue([{ id: 'ghl-appt', startTime: ghlTime, status: 'confirmed', calendarId: 'cal' }]);
    const res = await run();
    expect(ghl.cancelAppointment).toHaveBeenCalledWith('ghl-appt');
    expect(res).toMatchObject({ cancelled: true });
  });

  it('GHL cancel fails → not cancelled + booking_failed event, conversation NOT reopened', async () => {
    ghl.cancelAppointment.mockRejectedValue(new Error('ghl 500'));
    const res = await run();
    expect(res.cancelled).toBe(false);
    expect(q.logBotEvent).toHaveBeenCalledWith('client1', 'conv1', 'booking_failed', expect.objectContaining({ stage: 'cancel' }));
    expect(q.reactivateConversation).not.toHaveBeenCalled();
  });
});

describe('cancelAppointment — the `cita-cancelada` tag', () => {
  it('a real cancellation tags the contact (smart lists / reactivation campaigns)', async () => {
    await run();
    expect(ghl.addContactTags).toHaveBeenCalledWith('c1', ['cita-cancelada']);
  });

  it('GHL cancel failed → nothing was cancelled, so no tag', async () => {
    ghl.cancelAppointment.mockRejectedValue(new Error('ghl 500'));
    await run();
    expect(ghl.addContactTags).not.toHaveBeenCalled();
  });

  it('a tag failure never fails the cancellation the lead already got', async () => {
    ghl.addContactTags.mockRejectedValue(new Error('tags 500'));
    const res = await run();
    expect(res).toMatchObject({ cancelled: true });
    expect(ghl.cancelAppointment).toHaveBeenCalledWith('appt1');
  });

  it('demo mode: a simulated cancel never tags the real contact', async () => {
    const demoTurn = { ...turn, activeRole: 'demo' } as TurnContext;
    const demoCtx = { requestContext: { get: (k: string) => (k === 'tenant' ? tenant : k === 'turn' ? demoTurn : undefined) } };
    vi.mocked(q.getActiveDemoSession).mockResolvedValue({ id: 'ds1', simulatedBooking: { startTime: '2099-07-10T17:00:00-06:00', serviceName: 'Valoración', label: 'x' } } as never);
    vi.mocked(q.setSimulatedBooking).mockResolvedValue(undefined);
    const res = await (cancelAppointmentTool.execute as (i: Record<string, never>, c: typeof demoCtx) => Promise<{ cancelled: boolean }>)({}, demoCtx);
    expect(res.cancelled).toBe(true);
    expect(ghl.cancelAppointment).not.toHaveBeenCalled();
    expect(ghl.addContactTags).not.toHaveBeenCalled();
  });
});

// Paid confirmation (0062): cancelling releases a pending hold; a paid one goes to review.
vi.mock('./booking-hold.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./booking-hold.js')>()),
  releaseBookingHold: vi.fn(),
}));
import { releaseBookingHold } from './booking-hold.js';

describe('cancelAppointment — paid confirmation (0062)', () => {
  const payTenant = { ...tenant, config: { ...(tenant.config as object), bookingPayment: { amount: 500 } } } as unknown as TenantContext;
  const payCtx = { requestContext: { get: (k: string) => (k === 'tenant' ? payTenant : k === 'turn' ? turn : undefined) } };
  const runPaid = () =>
    (cancelAppointmentTool.execute as (i: Record<string, never>, c: typeof payCtx) => Promise<{ cancelled: boolean; message: string }>)({}, payCtx);

  beforeEach(() => {
    vi.mocked(q.getBookingHold).mockResolvedValue({ id: 'h1', status: 'pending' } as never);
  });

  it('pending hold released → plain "Cita cancelada."', async () => {
    vi.mocked(releaseBookingHold).mockResolvedValue('released');
    const res = await runPaid();
    expect(res.cancelled).toBe(true);
    expect(releaseBookingHold).toHaveBeenCalledWith(expect.objectContaining({ ghlAppointmentId: 'appt1', ghlContactId: 'c1' }));
    expect(res.message).toBe('Cita cancelada.');
  });

  it('paid hold → REFUSED before touching GHL: the model offers to reschedule instead', async () => {
    vi.mocked(q.getBookingHold).mockResolvedValue({ id: 'h1', status: 'paid' } as never);
    const res = await runPaid();
    expect(res.cancelled).toBe(false);
    expect(ghl.cancelAppointment).not.toHaveBeenCalled();
    expect(releaseBookingHold).not.toHaveBeenCalled();
    expect(res.message).toContain('NO se cancela');
    expect(res.message).toContain('disculpa');
    expect(res.message).toContain('getAvailability');
    expect(q.logBotEvent).toHaveBeenCalledWith('client1', 'conv1', 'booking_failed', expect.objectContaining({ stage: 'cancel', reason: 'paid_hold' }));
  });

  it('paid_late is paid too → refused', async () => {
    vi.mocked(q.getBookingHold).mockResolvedValue({ id: 'h1', status: 'paid_late' } as never);
    const res = await runPaid();
    expect(res.cancelled).toBe(false);
    expect(ghl.cancelAppointment).not.toHaveBeenCalled();
  });

  it('a hold read failure does not block a cancel of an unpaid cita', async () => {
    vi.mocked(q.getBookingHold).mockRejectedValue(new Error('db'));
    vi.mocked(releaseBookingHold).mockResolvedValue('released');
    const res = await runPaid();
    expect(res.cancelled).toBe(true);
  });

  it('a release failure never turns a cancellation that happened into an error', async () => {
    vi.mocked(releaseBookingHold).mockRejectedValue(new Error('db'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await runPaid();
    expect(res.cancelled).toBe(true);
    spy.mockRestore();
  });

  it('a tenant without booking_payment never touches the hold', async () => {
    await run();
    expect(releaseBookingHold).not.toHaveBeenCalled();
  });
});
