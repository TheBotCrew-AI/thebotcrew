import { describe, it, expect, vi, beforeEach } from 'vitest';
import { findUpcomingAppointment, type ContactAppointmentsSource } from './upcoming-appointment.js';
import { loadAppointmentLog } from './queries.js';

vi.mock('./queries.js', () => ({
  loadAppointmentLog: vi.fn(),
}));

const NOW = Date.parse('2026-08-02T12:00:00Z');
const TZ = 'America/Tijuana';
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
  live?: { startTime?: string; status?: string } | Error,
): ContactAppointmentsSource & { calls: number; reads: string[] } {
  const src = {
    calls: 0,
    reads: [] as string[],
    async getContactAppointments() {
      src.calls += 1;
      return events;
    },
    ...(live === undefined
      ? {}
      : {
          async getAppointment(id: string) {
            src.reads.push(id);
            if (live instanceof Error) throw live;
            return live;
          },
        }),
  };
  return src;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('findUpcomingAppointment', () => {
  it('returns the store appointment when it is future and not cancelled — no contact-wide GHL call', async () => {
    mockLog.mockResolvedValue([row()]);
    const ghl = ghlWith([]);
    const out = await findUpcomingAppointment('client', 'contact', ghl, NOW, TZ);
    expect(out).toEqual({ startTime: FUTURE, service: 'facial' });
    expect(ghl.calls).toBe(0);
  });

  it('a store appointment GHL now reports cancelled is NOT upcoming (the 2026-10-14 Heriberto test)', async () => {
    mockLog.mockResolvedValue([row()]);
    const ghl = ghlWith([], { status: 'cancelled', startTime: FUTURE });
    const out = await findUpcomingAppointment('client', 'contact', ghl, NOW, TZ);
    expect(out).toBeNull();
    expect(ghl.reads).toEqual(['a1']);
    expect(ghl.calls).toBe(1); // history exists → GHL asked for another appointment
  });

  it('a store appointment moved in GHL is returned at its LIVE time', async () => {
    mockLog.mockResolvedValue([row()]);
    const ghl = ghlWith([], { status: 'confirmed', startTime: LATER });
    const out = await findUpcomingAppointment('client', 'contact', ghl, NOW, TZ);
    expect(out).toEqual({ startTime: LATER, service: 'facial' });
    expect(ghl.calls).toBe(0);
  });

  it('the live read failing keeps the store answer (never fails toward chasing a booked lead)', async () => {
    mockLog.mockResolvedValue([row()]);
    const ghl = ghlWith([], new Error('401'));
    const out = await findUpcomingAppointment('client', 'contact', ghl, NOW, TZ);
    expect(out).toEqual({ startTime: FUTURE, service: 'facial' });
  });

  it('two upcoming citas in the store → the SOONEST, not the newest-created (2026-08-02 MADI)', async () => {
    mockLog.mockResolvedValue([
      row({ ghlAppointmentId: 'second-booking', appointmentDatetime: LATER, createdAt: '2026-08-02T03:48:00Z' }),
      row({ ghlAppointmentId: 'first-booking', appointmentDatetime: FUTURE, createdAt: '2026-08-02T03:46:00Z' }),
    ]);
    const out = await findUpcomingAppointment('client', 'contact', ghlWith([]), NOW, TZ);
    expect(out?.startTime).toBe(FUTURE);
  });

  it('a later cancelled row supersedes the booked row of the same appointment', async () => {
    mockLog.mockResolvedValue([
      row({ action: 'cancelled', createdAt: '2026-08-02T00:00:00Z' }),
      row({ action: 'booked', createdAt: '2026-08-01T00:00:00Z' }),
    ]);
    const ghl = ghlWith([]);
    const out = await findUpcomingAppointment('client', 'contact', ghl, NOW, TZ);
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
    const out = await findUpcomingAppointment('client', 'contact', ghl, NOW, TZ);
    // Soonest upcoming that is neither cancelled nor deleted.
    expect(out).toEqual({ startTime: FUTURE, service: 'Sesión 1' });
    expect(ghl.calls).toBe(1);
  });

  it('no store rows → null WITHOUT a GHL call (fresh leads stay cheap)', async () => {
    mockLog.mockResolvedValue([]);
    const ghl = ghlWith([{ id: 'g1', startTime: FUTURE }]);
    const out = await findUpcomingAppointment('client', 'contact', ghl, NOW, TZ);
    expect(out).toBeNull();
    expect(ghl.calls).toBe(0);
  });

  it('no store rows + alwaysCheckGhl (the runner backstop) → GHL still consulted', async () => {
    mockLog.mockResolvedValue([]);
    const ghl = ghlWith([{ id: 'g1', startTime: FUTURE, title: 'walk-in' }]);
    const out = await findUpcomingAppointment('client', 'contact', ghl, NOW, TZ, { alwaysCheckGhl: true });
    expect(out).toEqual({ startTime: FUTURE, service: 'walk-in' });
    expect(ghl.calls).toBe(1);
  });

  it('GHL failure shape ([]) fails open to "no appointment"', async () => {
    mockLog.mockResolvedValue([row({ appointmentDatetime: PAST })]);
    const out = await findUpcomingAppointment('client', 'contact', ghlWith([]), NOW, TZ);
    expect(out).toBeNull();
  });

  it('ignores GHL events with unparsable or missing start times', async () => {
    mockLog.mockResolvedValue([]);
    const ghl = ghlWith([
      { id: 'g1' },
      { id: 'g2', startTime: 'no-es-fecha' },
    ]);
    const out = await findUpcomingAppointment('client', 'contact', ghl, NOW, TZ, { alwaysCheckGhl: true });
    expect(out).toBeNull();
  });
});
