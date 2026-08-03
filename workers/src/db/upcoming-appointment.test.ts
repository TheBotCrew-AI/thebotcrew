import { describe, it, expect, vi, beforeEach } from 'vitest';
import { findUpcomingAppointment, type ContactAppointmentsSource } from './upcoming-appointment.js';
import { loadAppointmentLog } from './queries.js';

vi.mock('./queries.js', () => ({
  loadAppointmentLog: vi.fn(),
}));

const NOW = Date.parse('2026-08-02T12:00:00Z');
const FUTURE = '2026-08-05T17:00:00Z';
const LATER = '2026-08-06T17:00:00Z';
const PAST = '2026-07-20T17:00:00Z';

const mockLog = vi.mocked(loadAppointmentLog);
const row = (o: Record<string, unknown> = {}) => ({
  ghlAppointmentId: 'a1', appointmentDatetime: FUTURE, serviceType: 'facial',
  action: 'booked', createdAt: '2026-08-01T00:00:00Z', ...o,
}) as never;

function ghlWith(
  events: Array<{ id: string; startTime?: string; status?: string; title?: string; deleted?: boolean }>,
): ContactAppointmentsSource & { calls: number } {
  const src = {
    calls: 0,
    async getContactAppointments() {
      src.calls += 1;
      return events;
    },
  };
  return src;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('findUpcomingAppointment', () => {
  it('returns the store appointment when it is future and not cancelled — no GHL call', async () => {
    mockLog.mockResolvedValue([row()]);
    const ghl = ghlWith([]);
    const out = await findUpcomingAppointment('client', 'contact', ghl, NOW);
    expect(out).toEqual({ startTime: FUTURE, service: 'facial' });
    expect(ghl.calls).toBe(0);
  });

  it('two upcoming citas in the store → the SOONEST, not the newest-created (2026-08-02 MADI)', async () => {
    mockLog.mockResolvedValue([
      row({ ghlAppointmentId: 'second-booking', appointmentDatetime: LATER, createdAt: '2026-08-02T03:48:00Z' }),
      row({ ghlAppointmentId: 'first-booking', appointmentDatetime: FUTURE, createdAt: '2026-08-02T03:46:00Z' }),
    ]);
    const out = await findUpcomingAppointment('client', 'contact', ghlWith([]), NOW);
    expect(out?.startTime).toBe(FUTURE);
  });

  it('a later cancelled row supersedes the booked row of the same appointment', async () => {
    mockLog.mockResolvedValue([
      row({ action: 'cancelled', createdAt: '2026-08-02T00:00:00Z' }),
      row({ action: 'booked', createdAt: '2026-08-01T00:00:00Z' }),
    ]);
    const ghl = ghlWith([]);
    const out = await findUpcomingAppointment('client', 'contact', ghl, NOW);
    expect(out).toBeNull();
    expect(ghl.calls).toBe(1); // history exists → GHL consulted
  });

  it('store rows all in the past (the package trap) → asks GHL and finds the staff-booked one', async () => {
    mockLog.mockResolvedValue([row({ appointmentDatetime: PAST })]);
    const ghl = ghlWith([
      { id: 'g1', startTime: '2026-08-09T16:00:00Z', title: 'Sesión 2' },
      { id: 'g2', startTime: FUTURE, title: 'Sesión 1' },
      { id: 'g3', startTime: '2026-08-01T16:00:00Z', title: 'pasada' },
      { id: 'g4', startTime: '2026-08-04T16:00:00Z', status: 'cancelled' },
      { id: 'g5', startTime: '2026-08-03T16:00:00Z', deleted: true },
    ]);
    const out = await findUpcomingAppointment('client', 'contact', ghl, NOW);
    // Soonest upcoming that is neither cancelled nor deleted.
    expect(out).toEqual({ startTime: FUTURE, service: 'Sesión 1' });
    expect(ghl.calls).toBe(1);
  });

  it('no store rows → null WITHOUT a GHL call (fresh leads stay cheap)', async () => {
    mockLog.mockResolvedValue([]);
    const ghl = ghlWith([{ id: 'g1', startTime: FUTURE }]);
    const out = await findUpcomingAppointment('client', 'contact', ghl, NOW);
    expect(out).toBeNull();
    expect(ghl.calls).toBe(0);
  });

  it('no store rows + alwaysCheckGhl (the runner backstop) → GHL still consulted', async () => {
    mockLog.mockResolvedValue([]);
    const ghl = ghlWith([{ id: 'g1', startTime: FUTURE, title: 'walk-in' }]);
    const out = await findUpcomingAppointment('client', 'contact', ghl, NOW, { alwaysCheckGhl: true });
    expect(out).toEqual({ startTime: FUTURE, service: 'walk-in' });
    expect(ghl.calls).toBe(1);
  });

  it('GHL failure shape ([]) fails open to "no appointment"', async () => {
    mockLog.mockResolvedValue([row({ appointmentDatetime: PAST })]);
    const out = await findUpcomingAppointment('client', 'contact', ghlWith([]), NOW);
    expect(out).toBeNull();
  });

  it('ignores GHL events with unparsable or missing start times', async () => {
    mockLog.mockResolvedValue([]);
    const ghl = ghlWith([
      { id: 'g1' },
      { id: 'g2', startTime: 'no-es-fecha' },
    ]);
    const out = await findUpcomingAppointment('client', 'contact', ghl, NOW, { alwaysCheckGhl: true });
    expect(out).toBeNull();
  });
});
