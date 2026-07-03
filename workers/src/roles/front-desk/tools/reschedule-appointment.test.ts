import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TenantContext, TurnContext } from '../../../core/types.js';

const ghl = { getAvailability: vi.fn(), rescheduleAppointment: vi.fn() };
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
  vi.mocked(q.loadLatestAppointment).mockResolvedValue(appt() as never);
  vi.mocked(q.logAppointment).mockResolvedValue({ appointmentId: 'a-uuid' } as never);
  vi.mocked(q.logBotEvent).mockResolvedValue(undefined);
  ghl.getAvailability.mockResolvedValue([{ start: START, end: START }]);
  ghl.rescheduleAppointment.mockResolvedValue(undefined);
});

describe('rescheduleAppointment', () => {
  it('no active appointment → not rescheduled', async () => {
    vi.mocked(q.loadLatestAppointment).mockResolvedValue(null);
    const res = await run(START);
    expect(res).toMatchObject({ rescheduled: false });
    expect(res.message).toContain('No encuentro una cita activa');
  });

  it('latest appointment is cancelled → treated as none', async () => {
    vi.mocked(q.loadLatestAppointment).mockResolvedValue(appt({ action: 'cancelled' }) as never);
    const res = await run(START);
    expect(res.rescheduled).toBe(false);
  });

  it('service has no configured calendar → cannot reschedule', async () => {
    vi.mocked(q.loadLatestAppointment).mockResolvedValue(appt({ serviceType: 'Desconocido' }) as never);
    const res = await run(START);
    expect(res.message).toContain('No pude identificar el calendario');
    expect(ghl.getAvailability).not.toHaveBeenCalled();
  });

  it('requested time beyond horizon → rejected before hitting GHL', async () => {
    const res = await run(inDays(30), makeCtx(7));
    expect(res.rescheduled).toBe(false);
    expect(res.message).toContain('fuera de la ventana');
    expect(ghl.getAvailability).not.toHaveBeenCalled();
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

  it('GHL reschedule fails → not rescheduled + booking_failed event', async () => {
    ghl.rescheduleAppointment.mockRejectedValue(new Error('ghl 422'));
    const res = await run(START);
    expect(res.rescheduled).toBe(false);
    expect(q.logBotEvent).toHaveBeenCalledWith('client1', 'conv1', 'booking_failed', expect.objectContaining({ stage: 'reschedule' }));
  });
});
