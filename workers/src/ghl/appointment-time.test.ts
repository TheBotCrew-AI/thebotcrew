import { describe, expect, it } from 'vitest';
import { ghlAppointmentInstant } from './appointment-time.js';

const TJ = 'America/Tijuana';

describe('ghlAppointmentInstant', () => {
  it('reads GHL wall-clock in the tenant zone (PDT and PST)', () => {
    expect(ghlAppointmentInstant('2026-10-06 08:00:00', TJ)).toBe('2026-10-06T15:00:00.000Z');
    expect(ghlAppointmentInstant('2026-12-01 08:00:00', TJ)).toBe('2026-12-01T16:00:00.000Z');
    expect(ghlAppointmentInstant('2026-10-06T08:00', TJ)).toBe('2026-10-06T15:00:00.000Z');
    expect(ghlAppointmentInstant('2026-10-06 18:30:00', 'America/Mexico_City')).toBe('2026-10-07T00:30:00.000Z');
  });

  it('passes an offset-carrying time through unchanged', () => {
    expect(ghlAppointmentInstant('2026-10-06T08:00:00-07:00', TJ)).toBe('2026-10-06T08:00:00-07:00');
    expect(ghlAppointmentInstant('2026-10-06T15:00:00Z', TJ)).toBe('2026-10-06T15:00:00Z');
  });

  it('returns undefined for missing or unrecognizable input instead of guessing', () => {
    expect(ghlAppointmentInstant(undefined, TJ)).toBeUndefined();
    expect(ghlAppointmentInstant('', TJ)).toBeUndefined();
    expect(ghlAppointmentInstant('agosto 9, 4:00 pm', TJ)).toBeUndefined();
  });
});
