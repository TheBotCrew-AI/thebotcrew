import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TenantContext, TurnContext } from '../../../core/types.js';

const ghl = { getAvailability: vi.fn(), rescheduleAppointment: vi.fn(), getContactAppointments: vi.fn(), updateContactTimezone: vi.fn() };
vi.mock('../../../ghl/client.js', () => ({ GhlClient: vi.fn(() => ghl) }));
vi.mock('../../../db/queries.js');

import * as q from '../../../db/queries.js';
import { rescheduleAppointmentTool } from './reschedule-appointment.js';

function makeCtx(bookingHorizonDays: number | null = null) {
  const tenant = {
    tenantId: 't1',
    clientId: 'client1',
    ghlLocationId: 'loc1',
    config: {
      businessName: 'Demo',
      timezone: 'America/Mexico_City',
      tone: null,
      services: [{ name: 'Consulta', durationMin: 30 }],
      hours: {},
      calendars: { Consulta: 'cal1' },
      faq: [],
      promptOverrides: {},
      bookingHorizonDays,
    },
  } as unknown as TenantContext;
  const turn = { ghlContactId: 'c1', ghlConversationId: 'conv1', channel: 'whatsapp' } as TurnContext;
  return { requestContext: { get: (k: string) => (k === 'tenant' ? tenant : k === 'turn' ? turn : undefined) } };
}

type Out = { rescheduled: boolean; message: string };
const run = (startTime: string, ctx = makeCtx()) =>
  (rescheduleAppointmentTool.execute as (i: { startTime: string }, c: ReturnType<typeof makeCtx>) => Promise<Out>)({ startTime }, ctx);

const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();
const START = inDays(2);
const appt = (o: Record<string, unknown> = {}) => ({ ghlAppointmentId: 'appt1', appointmentDatetime: inDays(1), serviceType: 'Consulta', action: 'booked', ...o });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(q.loadAppointmentLog).mockResolvedValue([appt()] as never);
  vi.mocked(q.logAppointment).mockResolvedValue({ appointmentId: 'a-uuid' } as never);
  vi.mocked(q.logBotEvent).mockResolvedValue(undefined);
  ghl.getAvailability.mockResolvedValue([{ start: START, end: START }]);
  ghl.rescheduleAppointment.mockResolvedValue(undefined);
  ghl.getContactAppointments.mockResolvedValue([]);
});

describe('rescheduleAppointment', () => {
  it('no active appointment → not rescheduled', async () => {
    vi.mocked(q.loadAppointmentLog).mockResolvedValue([]);
    const res = await run(START);
    expect(res).toMatchObject({ rescheduled: false });
    expect(res.message).toContain('No encuentro una cita activa');
  });

  it('latest appointment is cancelled → treated as none', async () => {
    vi.mocked(q.loadAppointmentLog).mockResolvedValue([appt({ action: 'cancelled' })] as never);
    const res = await run(START);
    expect(res.rescheduled).toBe(false);
  });

  it('service has no configured calendar → cannot reschedule', async () => {
    vi.mocked(q.loadAppointmentLog).mockResolvedValue([appt({ serviceType: 'Desconocido' })] as never);
    const res = await run(START);
    expect(res.message).toContain('No pude identificar el calendario');
    expect(ghl.getAvailability).not.toHaveBeenCalled();
  });

  it('requested time beyond horizon → rejected on the RESOLVED instant, never moved', async () => {
    // The horizon is now checked after resolving the slot (as bookAppointment does):
    // you cannot horizon-check a string whose offset the model may have dropped —
    // that would be measuring the wrong instant.
    const far = inDays(30);
    ghl.getAvailability.mockResolvedValue([{ start: far, end: far }]);
    const res = await run(far, makeCtx(7));
    expect(res.rescheduled).toBe(false);
    expect(res.message).toContain('fuera de la ventana');
    expect(ghl.rescheduleAppointment).not.toHaveBeenCalled();
    expect(q.logBotEvent).toHaveBeenCalledWith('client1', 'conv1', 'booking_failed',
      expect.objectContaining({ reason: 'out_of_horizon' }));
  });

  it('requested time is not a real free slot → rejected', async () => {
    ghl.getAvailability.mockResolvedValue([{ start: inDays(5), end: inDays(5) }]); // different time
    const res = await run(START);
    expect(res.rescheduled).toBe(false);
    expect(res.message).toContain('no está disponible');
    expect(ghl.rescheduleAppointment).not.toHaveBeenCalled();
  });

  it('availability check fails → safe error, no move', async () => {
    ghl.getAvailability.mockRejectedValue(new Error('ghl 500'));
    const res = await run(START);
    expect(res.rescheduled).toBe(false);
    expect(res.message).toContain('No pude verificar la disponibilidad');
    expect(ghl.rescheduleAppointment).not.toHaveBeenCalled();
  });

  it('valid free slot → moves the appointment (with derived endTime)', async () => {
    const res = await run(START);
    expect(ghl.rescheduleAppointment).toHaveBeenCalledWith(
      expect.objectContaining({ appointmentId: 'appt1', calendarId: 'cal1', startTime: START, endTime: expect.any(String) }),
    );
    expect(res.rescheduled).toBe(true);
    expect(q.logAppointment).toHaveBeenCalledWith(expect.objectContaining({ p_action: 'rescheduled', p_ghl_appointment_id: 'appt1' }));
  });

  it('a plain tenant never writes the contact timezone field', async () => {
    await run(START);
    expect(ghl.updateContactTimezone).not.toHaveBeenCalled();
  });

  it('a lead-timezone tenant mirrors the lead zone onto the contact BEFORE moving the appointment', async () => {
    ghl.updateContactTimezone.mockResolvedValue(undefined);
    const base = makeCtx();
    const tenant = base.requestContext.get('tenant') as TenantContext;
    const t = { ...tenant, config: { ...(tenant.config as object), leadTimezoneEnabled: true } } as unknown as TenantContext;
    const tn = { ...(base.requestContext.get('turn') as TurnContext), leadTimezone: 'America/Mexico_City' } as TurnContext;
    const ctx = { requestContext: { get: (k: string) => (k === 'tenant' ? t : k === 'turn' ? tn : undefined) } };
    const res = await run(START, ctx);
    expect(res.rescheduled).toBe(true);
    expect(ghl.updateContactTimezone).toHaveBeenCalledWith('c1', 'America/Mexico_City');
    expect(ghl.updateContactTimezone.mock.invocationCallOrder[0]!).toBeLessThan(ghl.rescheduleAppointment.mock.invocationCallOrder[0]!);
  });

  it('store miss but GHL has the appointment (booked in GHL) → reschedules it via GHL data', async () => {
    vi.mocked(q.loadAppointmentLog).mockResolvedValue([]);
    ghl.getContactAppointments.mockResolvedValue([{ id: 'ghl-appt', startTime: inDays(1), status: 'confirmed', calendarId: 'cal1' }]);
    const res = await run(START);
    expect(res.rescheduled).toBe(true);
    // Uses the GHL appointment id + its own calendarId, reverse-mapped to the configured service.
    expect(ghl.rescheduleAppointment).toHaveBeenCalledWith(
      expect.objectContaining({ appointmentId: 'ghl-appt', calendarId: 'cal1', startTime: START, endTime: expect.any(String) }),
    );
  });

  it('GHL reschedule fails → not rescheduled + booking_failed event', async () => {
    ghl.rescheduleAppointment.mockRejectedValue(new Error('ghl 422'));
    const res = await run(START);
    expect(res.rescheduled).toBe(false);
    expect(q.logBotEvent).toHaveBeenCalledWith('client1', 'conv1', 'booking_failed', expect.objectContaining({ stage: 'reschedule' }));
  });
});

describe('rescheduleAppointment — dropped timezone offset (2026-07-30 regression)', () => {
  // Tijuana is -07:00. The lead asked for "viernes 4:00 p.m."; the model emitted
  // 2026-07-31T16:00:00 with the offset stripped. Parsed as an instant that is
  // 16:00 UTC — which is a REAL free slot (9:00 a.m. Tijuana). The old instant-match
  // accepted it and moved the appointment to 9 a.m., seven hours early.
  const tj = () => {
    const tenant = {
      tenantId: 't1', clientId: 'client1', ghlLocationId: 'loc1',
      config: {
        businessName: 'The Bot Crew', timezone: 'America/Tijuana', tone: null,
        services: [{ name: 'Sesión de instalación', durationMin: 20 }], hours: {},
        calendars: { 'Sesión de instalación': 'cal-tj' }, faq: [], promptOverrides: {},
        bookingHorizonDays: null,
      },
    } as unknown as TenantContext;
    const turn = { ghlContactId: 'c1', ghlConversationId: 'conv1', channel: 'whatsapp' } as TurnContext;
    return { requestContext: { get: (k: string) => (k === 'tenant' ? tenant : k === 'turn' ? turn : undefined) } };
  };
  const NINE_AM = '2026-07-31T09:00:00-07:00'; // 16:00Z — the decoy
  const FOUR_PM = '2026-07-31T16:00:00-07:00'; // 23:00Z — what the lead actually asked for

  beforeEach(() => {
    vi.mocked(q.loadAppointmentLog).mockResolvedValue(
      // Far future: the resolver only serves FUTURE store rows (0049), and a hardcoded
      // near date rots into the past and silently reroutes the test through the GHL fallback.
      [{ ghlAppointmentId: 'appt1', appointmentDatetime: '2099-01-01T20:30:00Z', serviceType: 'Sesión de instalación', action: 'booked' }] as never,
    );
    ghl.getAvailability.mockResolvedValue([
      { start: NINE_AM, end: NINE_AM },
      { start: FOUR_PM, end: FOUR_PM },
    ]);
  });

  it('books the 4 p.m. slot when the model drops the offset — not the 9 a.m. decoy', async () => {
    const res = await (rescheduleAppointmentTool.execute as (i: { startTime: string }, c: unknown) => Promise<Out>)(
      { startTime: '2026-07-31T16:00:00' }, tj(),
    );
    expect(res.rescheduled).toBe(true);
    expect(ghl.rescheduleAppointment).toHaveBeenCalledWith(
      expect.objectContaining({ startTime: FOUR_PM }),
    );
    // Our store must agree with GHL, not with the model's string.
    expect(q.logAppointment).toHaveBeenCalledWith(
      expect.objectContaining({ p_appointment_datetime: FOUR_PM }),
    );
    // And the agent gets a tenant-tz label to read back verbatim.
    expect(res.message).toContain('4:00');
  });

  it('an explicit offset is still honoured by instant', async () => {
    const res = await (rescheduleAppointmentTool.execute as (i: { startTime: string }, c: unknown) => Promise<Out>)(
      { startTime: NINE_AM }, tj(),
    );
    expect(res.rescheduled).toBe(true);
    expect(ghl.rescheduleAppointment).toHaveBeenCalledWith(expect.objectContaining({ startTime: NINE_AM }));
  });

  it('a wall-clock with no matching slot is refused, not silently snapped', async () => {
    const res = await (rescheduleAppointmentTool.execute as (i: { startTime: string }, c: unknown) => Promise<Out>)(
      { startTime: '2026-07-31T13:13:00' }, tj(),
    );
    expect(res.rescheduled).toBe(false);
    expect(ghl.rescheduleAppointment).not.toHaveBeenCalled();
    expect(q.logBotEvent).toHaveBeenCalledWith('client1', 'conv1', 'booking_failed',
      expect.objectContaining({ reason: 'slot_unavailable' }));
  });
});
