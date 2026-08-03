import { describe, it, expect } from 'vitest';
import { isAppointmentActive, soonestUpcomingAppointment, type AppointmentLogRow } from './appointment-active.js';

const NOW = Date.parse('2026-07-04T12:00:00-07:00');
const future = '2026-07-04T14:30:00-07:00'; // +2.5h
const past = '2026-07-04T09:00:00-07:00'; // -3h

describe('isAppointmentActive', () => {
  it('returns false when there is no appointment', () => {
    expect(isAppointmentActive(null, NOW)).toBe(false);
  });

  it('returns false for a cancelled appointment even if in the future', () => {
    expect(isAppointmentActive({ action: 'cancelled', appointmentDatetime: future }, NOW)).toBe(false);
  });

  it('returns false for a past appointment (does not block a fresh booking)', () => {
    expect(isAppointmentActive({ action: 'booked', appointmentDatetime: past }, NOW)).toBe(false);
  });

  it('returns false when the datetime is missing or unparseable', () => {
    expect(isAppointmentActive({ action: 'booked', appointmentDatetime: null }, NOW)).toBe(false);
    expect(isAppointmentActive({ action: 'booked', appointmentDatetime: 'not-a-date' }, NOW)).toBe(false);
  });

  it('returns true for a future booked appointment', () => {
    expect(isAppointmentActive({ action: 'booked', appointmentDatetime: future }, NOW)).toBe(true);
  });

  it('returns true for a future rescheduled appointment', () => {
    expect(isAppointmentActive({ action: 'rescheduled', appointmentDatetime: future }, NOW)).toBe(true);
  });
});

describe('soonestUpcomingAppointment — collapse the event log, pick the next cita', () => {
  const later = '2026-07-06T10:00:00-07:00';
  const row = (o: Partial<AppointmentLogRow>): AppointmentLogRow => ({
    ghlAppointmentId: 'a1', action: 'booked', appointmentDatetime: future,
    serviceType: null, createdAt: '2026-07-01T00:00:00Z', ...o,
  });

  it('empty log → null', () => {
    expect(soonestUpcomingAppointment([], NOW)).toBeNull();
  });

  it('with several upcoming citas, the SOONEST wins — not the newest-created row', () => {
    // The 2026-08-02 MADI test: two staff bookings existed and the newest-created
    // (the later cita) shadowed the one the lead was actually confirming.
    const rows = [
      row({ ghlAppointmentId: 'second-created', appointmentDatetime: later, createdAt: '2026-07-02T00:00:00Z' }),
      row({ ghlAppointmentId: 'first-created', appointmentDatetime: future, createdAt: '2026-07-01T00:00:00Z' }),
    ];
    expect(soonestUpcomingAppointment(rows, NOW)?.ghlAppointmentId).toBe('first-created');
  });

  it('the latest action per appointment wins: a later cancel kills the booked row', () => {
    // rows are newest-first, as loadAppointmentLog orders them
    const rows = [
      row({ action: 'cancelled', createdAt: '2026-07-03T00:00:00Z' }),
      row({ action: 'booked', createdAt: '2026-07-01T00:00:00Z' }),
    ];
    expect(soonestUpcomingAppointment(rows, NOW)).toBeNull();
  });

  it('a later reschedule replaces the original time of the same appointment', () => {
    const rows = [
      row({ action: 'rescheduled', appointmentDatetime: later, createdAt: '2026-07-03T00:00:00Z' }),
      row({ action: 'booked', appointmentDatetime: future, createdAt: '2026-07-01T00:00:00Z' }),
    ];
    expect(soonestUpcomingAppointment(rows, NOW)?.appointmentDatetime).toBe(later);
  });

  it('past and dateless rows never surface', () => {
    const rows = [
      row({ ghlAppointmentId: 'p', appointmentDatetime: past }),
      row({ ghlAppointmentId: 'n', appointmentDatetime: null }),
    ];
    expect(soonestUpcomingAppointment(rows, NOW)).toBeNull();
  });
});
