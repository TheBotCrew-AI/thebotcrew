import { describe, it, expect } from 'vitest';
import { isPrimeSlot, isRestrictedService, parsePrimeTime, primeWindowsEs, splitPrimeSlots } from './prime-time.js';

const TZ = 'America/Mexico_City'; // UTC-6, no DST
const PRIME = parsePrimeTime({
  windows: [{ days: ['mon', 'tue', 'wed', 'thu', 'fri'], start: '17:00', end: '20:00' }],
  restricted_services: ['Valoración'],
})!;

describe('parsePrimeTime', () => {
  it('null / malformed → off', () => {
    expect(parsePrimeTime(null)).toBeNull();
    expect(parsePrimeTime('x')).toBeNull();
    expect(parsePrimeTime({ windows: [] })).toBeNull();
    expect(parsePrimeTime({ windows: [{ days: ['mon'], start: '5pm', end: '20:00' }], restricted_services: ['a'] })).toBeNull();
    expect(parsePrimeTime({ windows: [{ days: ['mon'], start: '17:00', end: '20:00' }], restricted_services: [] })).toBeNull();
  });
  it('accepts snake_case and camelCase', () => {
    expect(PRIME.restrictedServices).toEqual(['Valoración']);
    expect(parsePrimeTime({ windows: PRIME.windows, restrictedServices: ['x'] })?.restrictedServices).toEqual(['x']);
  });
});

describe('isPrimeSlot', () => {
  // 2026-10-07 is a Wednesday. 23:00Z = 17:00 in Mexico City.
  it('a weekday slot inside the window is prime, read in the tenant clock', () => {
    expect(isPrimeSlot('2026-10-07T23:00:00.000Z', PRIME, TZ)).toBe(true);
    expect(isPrimeSlot('2026-10-07T17:00:00-06:00', PRIME, TZ)).toBe(true);
    expect(isPrimeSlot('2026-10-08T01:30:00.000Z', PRIME, TZ)).toBe(true); // 19:30
  });
  it('the window end is exclusive and the start inclusive', () => {
    expect(isPrimeSlot('2026-10-07T20:00:00-06:00', PRIME, TZ)).toBe(false);
    expect(isPrimeSlot('2026-10-07T16:30:00-06:00', PRIME, TZ)).toBe(false);
  });
  it('a Saturday at 6 p.m. is not prime when the window is weekdays only', () => {
    expect(isPrimeSlot('2026-10-10T18:00:00-06:00', PRIME, TZ)).toBe(false);
  });
  it('the day boundary is the tenant day: 17:00 Tijuana is 18:00 CDMX → prime for a CDMX tenant', () => {
    expect(isPrimeSlot('2026-10-07T17:00:00-07:00', PRIME, TZ)).toBe(true);
    expect(isPrimeSlot('2026-10-07T17:00:00-07:00', PRIME, 'America/Tijuana')).toBe(true);
    expect(isPrimeSlot('2026-10-07T16:00:00-07:00', PRIME, 'America/Tijuana')).toBe(false);
  });
  it('an unreadable instant or zone is never prime', () => {
    expect(isPrimeSlot('garbage', PRIME, TZ)).toBe(false);
    expect(isPrimeSlot('2026-10-07T23:00:00.000Z', PRIME, 'Mars/Olympus')).toBe(false);
  });
});

describe('splitPrimeSlots / isRestrictedService / primeWindowsEs', () => {
  it('splits by the window and keeps order', () => {
    const slots = [
      { start: '2026-10-07T10:00:00-06:00' },
      { start: '2026-10-07T17:30:00-06:00' },
      { start: '2026-10-07T12:00:00-06:00' },
    ];
    const { offPeak, prime } = splitPrimeSlots(slots, PRIME, TZ);
    expect(offPeak.map((s) => s.start)).toEqual(['2026-10-07T10:00:00-06:00', '2026-10-07T12:00:00-06:00']);
    expect(prime.map((s) => s.start)).toEqual(['2026-10-07T17:30:00-06:00']);
  });
  it('restricted only by exact service name', () => {
    expect(isRestrictedService(PRIME, 'Valoración')).toBe(true);
    expect(isRestrictedService(PRIME, 'Bótox')).toBe(false);
    expect(isRestrictedService(null, 'Valoración')).toBe(false);
  });
  it('renders the windows in Spanish', () => {
    expect(primeWindowsEs(PRIME)).toBe('lunes, martes, miércoles, jueves y viernes de 5:00 p.m. a 8:00 p.m.');
  });
});
