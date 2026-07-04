import { describe, it, expect } from 'vitest';
import { isAppointmentActive } from './appointment-active.js';

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
