import { describe, it, expect } from 'vitest';
import {
  hasTimezoneOffset,
  wallClockKey,
  slotWallKey,
  requestAnchorMs,
  bookingQueryWindow,
  resolveBookableSlot,
  requestedInstantMs,
} from './booking-time.js';

describe('hasTimezoneOffset', () => {
  it.each([
    ['2026-07-08T17:15:00-07:00', true],
    ['2026-07-08T17:15:00+05:30', true],
    ['2026-07-08T17:15:00-0700', true],
    ['2026-07-08T17:15:00Z', true],
    ['2026-07-08T17:15:00', false], // the bug input: no offset
    ['2026-07-08T17:15', false],
  ])('%s → %s', (iso, expected) => {
    expect(hasTimezoneOffset(iso)).toBe(expected);
  });
});

describe('wallClockKey', () => {
  it('strips offset to YYYY-MM-DDTHH:mm', () => {
    expect(wallClockKey('2026-07-08T17:15:00-07:00')).toBe('2026-07-08T17:15');
    expect(wallClockKey('2026-07-08T17:15:00')).toBe('2026-07-08T17:15');
    expect(wallClockKey('2026-07-08 17:15:00Z')).toBe('2026-07-08T17:15');
  });
  it('returns null for non-datetime strings', () => {
    expect(wallClockKey('not a date')).toBeNull();
  });
});

describe('slotWallKey', () => {
  it('renders the instant in the tenant timezone', () => {
    // 17:15 at -07:00 is 5:15 p.m. in Tijuana.
    expect(slotWallKey('2026-07-08T17:15:00-07:00', 'America/Tijuana')).toBe('2026-07-08T17:15');
    // Same instant expressed as UTC (00:15 next day) still renders as 17:15 Tijuana.
    expect(slotWallKey('2026-07-09T00:15:00Z', 'America/Tijuana')).toBe('2026-07-08T17:15');
  });
  it('an offset-less instant read as UTC is 10:15 a.m. Tijuana (the bug)', () => {
    expect(slotWallKey('2026-07-08T17:15:00Z', 'America/Tijuana')).toBe('2026-07-08T10:15');
  });
  it('returns null on an unparseable instant', () => {
    expect(slotWallKey('nope', 'America/Tijuana')).toBeNull();
  });
});

describe('bookingQueryWindow / requestAnchorMs', () => {
  const now = Date.parse('2026-07-01T00:00:00Z');
  it('brackets the requested day by ±1 day', () => {
    const { fromMs, toMs } = bookingQueryWindow('2026-07-08T17:15:00', now);
    expect(toMs - fromMs).toBe(2 * 24 * 60 * 60 * 1000);
  });
  it('never lets `from` precede now', () => {
    const { fromMs } = bookingQueryWindow('2026-07-01T06:00:00', now);
    expect(fromMs).toBe(now);
  });
  it('honours an explicit offset when anchoring', () => {
    expect(requestAnchorMs('2026-07-08T17:15:00-07:00', now)).toBe(Date.parse('2026-07-08T17:15:00-07:00'));
  });
});

describe('resolveBookableSlot', () => {
  const tz = 'America/Tijuana';
  const slots = [
    { start: '2026-07-08T17:00:00-07:00', end: '2026-07-08T17:00:00-07:00' },
    { start: '2026-07-08T17:15:00-07:00', end: '2026-07-08T17:15:00-07:00' },
    { start: '2026-07-08T17:30:00-07:00', end: '2026-07-08T17:30:00-07:00' },
  ];

  it('matches an offset-less request by wall-clock and returns the canonical offset slot', () => {
    expect(resolveBookableSlot(slots, '2026-07-08T17:15:00', tz)).toBe('2026-07-08T17:15:00-07:00');
  });
  it('matches a request that carries the correct offset (by instant)', () => {
    expect(resolveBookableSlot(slots, '2026-07-08T17:15:00-07:00', tz)).toBe('2026-07-08T17:15:00-07:00');
  });
  it('matches the same instant expressed as UTC', () => {
    expect(resolveBookableSlot(slots, '2026-07-09T00:15:00Z', tz)).toBe('2026-07-08T17:15:00-07:00');
  });
  it('an explicit-offset request is matched by instant only — a UTC time not on the board → null', () => {
    // 17:15Z resolves to 10:15 a.m. Tijuana, which is not offered; the same DIGITS (17:15) do
    // appear as a local slot, but with an offset present we never fall back to digit matching.
    expect(resolveBookableSlot(slots, '2026-07-08T17:15:00Z', tz)).toBeNull();
  });
  it('returns null when nothing matches', () => {
    expect(resolveBookableSlot(slots, '2026-07-08T19:00:00', tz)).toBeNull();
  });
  it('returns null on empty availability', () => {
    expect(resolveBookableSlot([], '2026-07-08T17:15:00', tz)).toBeNull();
  });
});

describe('requestedInstantMs — an offset-less date means TENANT-local, not UTC', () => {
  const TJ = 'America/Tijuana'; // -07:00 in summer
  const FALLBACK = Date.parse('2026-01-01T00:00:00Z');

  it('honours an explicit offset', () => {
    expect(requestedInstantMs('2026-08-01T16:00:00-07:00', TJ, FALLBACK))
      .toBe(Date.parse('2026-08-01T23:00:00Z'));
    expect(requestedInstantMs('2026-08-01T23:00:00Z', TJ, FALLBACK))
      .toBe(Date.parse('2026-08-01T23:00:00Z'));
  });

  it('reads a bare wall-clock in the tenant timezone (the bug: it used to mean UTC)', () => {
    // Saturday midnight in Tijuana is 07:00Z, NOT 00:00Z. Reading it as UTC starts
    // the window on Friday 5pm local and truncates the real Saturday evening.
    expect(requestedInstantMs('2026-08-01T00:00:00', TJ, FALLBACK))
      .toBe(Date.parse('2026-08-01T07:00:00Z'));
    expect(requestedInstantMs('2026-08-01T23:59:00', TJ, FALLBACK))
      .toBe(Date.parse('2026-08-02T06:59:00Z'));
  });

  it('works for a positive-offset zone too', () => {
    expect(requestedInstantMs('2026-08-01T09:00:00', 'Europe/Madrid', FALLBACK))
      .toBe(Date.parse('2026-08-01T07:00:00Z')); // CEST = +02:00
  });

  it('falls back on missing or unparseable input', () => {
    expect(requestedInstantMs(undefined, TJ, FALLBACK)).toBe(FALLBACK);
    expect(requestedInstantMs('mañana por la tarde', TJ, FALLBACK)).toBe(FALLBACK);
  });
});
