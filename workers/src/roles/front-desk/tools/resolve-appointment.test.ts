import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../db/queries.js');

import * as q from '../../../db/queries.js';
import type { GhlClient } from '../../../ghl/client.js';
import { resolveActiveAppointment } from './resolve-appointment.js';

const NOW = Date.parse('2026-07-06T00:00:00Z');
const future = (h: number) => new Date(NOW + h * 3_600_000).toISOString();
const past = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

/** Minimal GhlClient stub — only getContactAppointments is exercised here. */
const ghlWith = (events: unknown[]) =>
  ({ getContactAppointments: vi.fn().mockResolvedValue(events) }) as unknown as GhlClient;

beforeEach(() => vi.clearAllMocks());

describe('resolveActiveAppointment', () => {
  it('store hit → returns the stored appointment, never touches GHL', async () => {
    vi.mocked(q.loadLatestAppointment).mockResolvedValue({
      ghlAppointmentId: 'stored-1', appointmentDatetime: future(24), serviceType: 'Valoración', action: 'booked',
    });
    const ghl = ghlWith([]);
    const res = await resolveActiveAppointment(ghl, 'client1', 'c1', NOW);
    expect(res).toEqual({
      ghlAppointmentId: 'stored-1', startTime: future(24), serviceType: 'Valoración', calendarId: null, source: 'store',
    });
    expect(ghl.getContactAppointments).not.toHaveBeenCalled();
  });

  it('store miss → falls back to the GHL appointment (booked outside the bot)', async () => {
    vi.mocked(q.loadLatestAppointment).mockResolvedValue(null);
    const ghl = ghlWith([
      { id: 'ghl-1', startTime: future(12), status: 'confirmed', calendarId: 'cal-9' },
    ]);
    const res = await resolveActiveAppointment(ghl, 'client1', 'c1', NOW);
    expect(res).toEqual({
      ghlAppointmentId: 'ghl-1', startTime: future(12), serviceType: null, calendarId: 'cal-9', source: 'ghl',
    });
  });

  it('store row is cancelled → still falls back to GHL for a live one', async () => {
    vi.mocked(q.loadLatestAppointment).mockResolvedValue({
      ghlAppointmentId: 'stored-x', appointmentDatetime: future(24), serviceType: 'Valoración', action: 'cancelled',
    });
    const ghl = ghlWith([{ id: 'ghl-2', startTime: future(3), status: 'confirmed', calendarId: 'cal-1' }]);
    const res = await resolveActiveAppointment(ghl, 'client1', 'c1', NOW);
    expect(res?.ghlAppointmentId).toBe('ghl-2');
    expect(res?.source).toBe('ghl');
  });

  it('GHL fallback picks the SOONEST upcoming and skips cancelled/deleted/past', async () => {
    vi.mocked(q.loadLatestAppointment).mockResolvedValue(null);
    const ghl = ghlWith([
      { id: 'past', startTime: past(2), status: 'confirmed', calendarId: 'cal' },
      { id: 'cancelled', startTime: future(1), status: 'cancelled', calendarId: 'cal' },
      { id: 'deleted', startTime: future(2), status: 'confirmed', calendarId: 'cal', deleted: true },
      { id: 'soonest', startTime: future(5), status: 'confirmed', calendarId: 'cal' },
      { id: 'later', startTime: future(30), status: 'confirmed', calendarId: 'cal' },
    ]);
    const res = await resolveActiveAppointment(ghl, 'client1', 'c1', NOW);
    expect(res?.ghlAppointmentId).toBe('soonest');
  });

  it('store miss + no upcoming GHL appointment → null', async () => {
    vi.mocked(q.loadLatestAppointment).mockResolvedValue(null);
    const ghl = ghlWith([{ id: 'old', startTime: past(1), status: 'confirmed', calendarId: 'cal' }]);
    expect(await resolveActiveAppointment(ghl, 'client1', 'c1', NOW)).toBeNull();
  });
});
