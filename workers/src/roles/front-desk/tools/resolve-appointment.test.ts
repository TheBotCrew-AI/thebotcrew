import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../db/queries.js');

import * as q from '../../../db/queries.js';
import type { GhlClient } from '../../../ghl/client.js';
import { resolveActiveAppointment } from './resolve-appointment.js';

const NOW = Date.parse('2026-07-06T00:00:00Z');
const future = (h: number) => new Date(NOW + h * 3_600_000).toISOString();
const past = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

/** One appointments event-log row (newest-first arrays feed loadAppointmentLog). */
const row = (o: Record<string, unknown> = {}) => ({
  ghlAppointmentId: 'stored-1', appointmentDatetime: future(24), serviceType: 'Valoración',
  action: 'booked', createdAt: past(1), ...o,
});

/** Minimal GhlClient stub — only getContactAppointments is exercised here. */
const ghlWith = (events: unknown[]) =>
  ({ getContactAppointments: vi.fn().mockResolvedValue(events) }) as unknown as GhlClient;

const log = (rows: unknown[]) => vi.mocked(q.loadAppointmentLog).mockResolvedValue(rows as never);

beforeEach(() => vi.clearAllMocks());

describe('resolveActiveAppointment', () => {
  it('store hit → returns the stored appointment, never touches GHL', async () => {
    log([row()]);
    const ghl = ghlWith([]);
    const res = await resolveActiveAppointment(ghl, 'client1', 'c1', NOW);
    expect(res).toEqual({
      ghlAppointmentId: 'stored-1', startTime: future(24), serviceType: 'Valoración', calendarId: null, source: 'store',
    });
    expect(ghl.getContactAppointments).not.toHaveBeenCalled();
  });

  it('store miss → falls back to the GHL appointment (booked outside the bot)', async () => {
    log([]);
    const ghl = ghlWith([
      { id: 'ghl-1', startTime: future(12), status: 'confirmed', calendarId: 'cal-9' },
    ]);
    const res = await resolveActiveAppointment(ghl, 'client1', 'c1', NOW);
    expect(res).toEqual({
      ghlAppointmentId: 'ghl-1', startTime: future(12), serviceType: null, calendarId: 'cal-9', source: 'ghl',
    });
  });

  it('store appointment cancelled → still falls back to GHL for a live one', async () => {
    log([row({ action: 'cancelled' })]);
    const ghl = ghlWith([{ id: 'ghl-2', startTime: future(3), status: 'confirmed', calendarId: 'cal-1' }]);
    const res = await resolveActiveAppointment(ghl, 'client1', 'c1', NOW);
    expect(res?.ghlAppointmentId).toBe('ghl-2');
    expect(res?.source).toBe('ghl');
  });

  it('a LATER cancelled row supersedes the original booked row of the same appointment', async () => {
    // Event-log semantics: cancel-appointment INSERTs a new row, never updates.
    log([
      row({ action: 'cancelled', createdAt: past(1) }),
      row({ action: 'booked', createdAt: past(2) }),
    ]);
    const ghl = ghlWith([]);
    expect(await resolveActiveAppointment(ghl, 'client1', 'c1', NOW)).toBeNull();
    expect(ghl.getContactAppointments).toHaveBeenCalled();
  });

  it('several upcoming citas → the SOONEST wins, not the newest-created (2026-08-02 MADI)', async () => {
    log([
      row({ ghlAppointmentId: 'later', appointmentDatetime: future(48), createdAt: past(1) }),
      row({ ghlAppointmentId: 'sooner', appointmentDatetime: future(12), createdAt: past(2) }),
    ]);
    const res = await resolveActiveAppointment(ghlWith([]), 'client1', 'c1', NOW);
    expect(res?.ghlAppointmentId).toBe('sooner');
  });

  it('GHL fallback picks the SOONEST upcoming and skips cancelled/deleted/past', async () => {
    log([]);
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
    log([]);
    const ghl = ghlWith([{ id: 'old', startTime: past(1), status: 'confirmed', calendarId: 'cal' }]);
    expect(await resolveActiveAppointment(ghl, 'client1', 'c1', NOW)).toBeNull();
  });

  it('store rows all in the PAST → GHL fallback is reached (the package-customer trap, 0049)', async () => {
    log([row({ appointmentDatetime: past(48), serviceType: 'Sesión 1' })]);
    const ghl = ghlWith([{ id: 'ghl-next', startTime: future(72), status: 'confirmed', calendarId: 'cal-2' }]);
    const res = await resolveActiveAppointment(ghl, 'client1', 'c1', NOW);
    expect(res?.ghlAppointmentId).toBe('ghl-next');
    expect(res?.source).toBe('ghl');
  });

  it('store row with an unparsable datetime → treated as inactive, GHL consulted', async () => {
    log([row({ appointmentDatetime: null })]);
    const ghl = ghlWith([]);
    expect(await resolveActiveAppointment(ghl, 'client1', 'c1', NOW)).toBeNull();
    expect(ghl.getContactAppointments).toHaveBeenCalled();
  });
});
