import { describe, it, expect } from 'vitest';
import { clampToActiveHours, DEFAULT_QUIET_HOURS, type QuietHours } from './active-hours.js';

// America/Mexico_City is UTC-6 year-round (no DST), so a fixed offset keeps these
// assertions readable: local = UTC - 6h.
const TZ = 'America/Mexico_City';

/** Build a UTC instant from Mexico-City local wall-clock components. */
function mx(dateLocal: string): Date {
  // dateLocal like '2026-07-01T23:30' (local). UTC = local + 6h.
  return new Date(`${dateLocal}:00-06:00`);
}

/** Local hour [0-23] of an instant in TZ, for asserting the clamp result. */
function localHour(d: Date): number {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: '2-digit', hour12: false }).format(d)) % 24;
}

describe('clampToActiveHours (default 21:00–08:00)', () => {
  it('pushes a late-night time to 08:00 the next morning', () => {
    const out = clampToActiveHours(mx('2026-07-01T23:30'), TZ);
    expect(localHour(out)).toBe(8);
    // Next calendar day, 08:00 local = 14:00 UTC.
    expect(out.toISOString()).toBe('2026-07-02T14:00:00.000Z');
  });

  it('pushes an early-morning time to 08:00 the same day', () => {
    const out = clampToActiveHours(mx('2026-07-01T03:00'), TZ);
    expect(out.toISOString()).toBe('2026-07-01T14:00:00.000Z');
  });

  it('pushes a time exactly at the start of the window (21:00)', () => {
    const out = clampToActiveHours(mx('2026-07-01T21:00'), TZ);
    expect(out.toISOString()).toBe('2026-07-02T14:00:00.000Z');
  });

  it('leaves a time exactly at the window end (08:00) untouched', () => {
    const base = mx('2026-07-01T08:00');
    expect(clampToActiveHours(base, TZ).getTime()).toBe(base.getTime());
  });

  it('leaves a daytime time untouched', () => {
    const base = mx('2026-07-01T14:15');
    expect(clampToActiveHours(base, TZ).getTime()).toBe(base.getTime());
  });

  it('leaves a time just before the window (20:59) untouched', () => {
    const base = mx('2026-07-01T20:59');
    expect(clampToActiveHours(base, TZ).getTime()).toBe(base.getTime());
  });

  it('exposes the platform default of 21:00–08:00', () => {
    expect(DEFAULT_QUIET_HOURS).toEqual({ start: 21, end: 8 });
  });
});

describe('clampToActiveHours (custom windows)', () => {
  it('honors a tenant override window (22:00–07:00)', () => {
    const quiet: QuietHours = { start: 22, end: 7 };
    // 21:30 is quiet under the default but active here → untouched.
    const active = mx('2026-07-01T21:30');
    expect(clampToActiveHours(active, TZ, quiet).getTime()).toBe(active.getTime());
    // 23:00 is quiet → pushed to 07:00 next day (13:00 UTC).
    expect(clampToActiveHours(mx('2026-07-01T23:00'), TZ, quiet).toISOString()).toBe('2026-07-02T13:00:00.000Z');
  });

  it('treats an empty window (start === end) as no quiet period', () => {
    const quiet: QuietHours = { start: 0, end: 0 };
    const base = mx('2026-07-01T03:00');
    expect(clampToActiveHours(base, TZ, quiet).getTime()).toBe(base.getTime());
  });
});
