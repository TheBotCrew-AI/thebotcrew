import { describe, it, expect } from 'vitest';
import { earliestBookableMs, resolveBookingWindow, SEVEN_DAYS_MS } from './booking-window.js';

const NOW = Date.parse('2026-07-01T00:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

describe('resolveBookingWindow', () => {
  it('no horizon: returns the requested range unchanged', () => {
    const w = resolveBookingWindow(NOW, '2026-07-05T00:00:00Z', '2026-07-10T00:00:00Z', null);
    expect(w).toEqual({
      fromMs: Date.parse('2026-07-05T00:00:00Z'),
      toMs: Date.parse('2026-07-10T00:00:00Z'),
      outOfHorizon: false,
      maxMs: null,
      clamped: false,
      tooSoon: false,
      minMs: null,
      liftedFrom: false,
    });
  });

  it('clamps a past `from` up to now', () => {
    const w = resolveBookingWindow(NOW, '2026-06-20T00:00:00Z', '2026-07-03T00:00:00Z', null);
    expect(w.fromMs).toBe(NOW);
  });

  it('defaults to now..+7d when dates are absent/invalid', () => {
    const w = resolveBookingWindow(NOW, undefined, 'not-a-date', null);
    expect(w.fromMs).toBe(NOW);
    expect(w.toMs).toBe(NOW + SEVEN_DAYS_MS);
  });

  it('clamps `to` down to the horizon and flags it', () => {
    const w = resolveBookingWindow(NOW, undefined, '2026-07-10T00:00:00Z', 3);
    expect(w.toMs).toBe(NOW + 3 * DAY);
    expect(w.clamped).toBe(true);
    expect(w.outOfHorizon).toBe(false);
  });

  it('clamps the default +7d window to the horizon', () => {
    const w = resolveBookingWindow(NOW, undefined, undefined, 3);
    expect(w.toMs).toBe(NOW + 3 * DAY);
    expect(w.clamped).toBe(true);
  });

  it('flags outOfHorizon when the whole range starts past the horizon', () => {
    const w = resolveBookingWindow(NOW, '2026-07-06T00:00:00Z', '2026-07-08T00:00:00Z', 3);
    expect(w.outOfHorizon).toBe(true);
    expect(w.maxMs).toBe(NOW + 3 * DAY);
  });

  it('leaves a range fully within the horizon untouched', () => {
    const w = resolveBookingWindow(NOW, '2026-07-01T06:00:00Z', '2026-07-02T00:00:00Z', 3);
    expect(w.clamped).toBe(false);
    expect(w.outOfHorizon).toBe(false);
    expect(w.toMs).toBe(Date.parse('2026-07-02T00:00:00Z'));
  });
});

describe('resolveBookingWindow — tenant-local interpretation of model dates', () => {
  const TJ = 'America/Tijuana';
  const NOW = Date.parse('2026-07-30T18:00:00Z'); // 11:00 Tijuana

  it("a bare 'end of Saturday' no longer truncates the day's real slots", () => {
    // The model writes "hasta el sábado" as 2026-08-01T23:59. Read as UTC that is
    // 16:59 Tijuana, cutting every Saturday evening slot out of the query.
    const w = resolveBookingWindow(NOW, undefined, '2026-08-01T23:59:00', null, TJ);
    expect(w.toMs).toBe(Date.parse('2026-08-02T06:59:00Z'));
  });

  it('a bare start-of-day is local midnight, not the previous evening', () => {
    const w = resolveBookingWindow(NOW, '2026-08-01T00:00:00', undefined, null, TJ);
    expect(w.fromMs).toBe(Date.parse('2026-08-01T07:00:00Z'));
  });

  it('an explicit offset is unchanged', () => {
    const w = resolveBookingWindow(NOW, '2026-08-01T00:00:00-07:00', undefined, null, TJ);
    expect(w.fromMs).toBe(Date.parse('2026-08-01T07:00:00Z'));
  });

  it('the horizon is measured against the correctly-resolved start', () => {
    // 2 days out in local terms; with a 7-day horizon this must NOT be out of range.
    const w = resolveBookingWindow(NOW, '2026-08-01T00:00:00', undefined, 7, TJ);
    expect(w.outOfHorizon).toBe(false);
  });

  it('defaults to UTC when no timezone is passed (back-compat)', () => {
    const w = resolveBookingWindow(NOW, '2026-08-01T00:00:00', undefined, null);
    expect(w.fromMs).toBe(Date.parse('2026-08-01T00:00:00Z'));
  });
});

// 0059: minimum notice — the near-side twin of the horizon. Same-day slots are never
// queried: `from` is lifted to LOCAL midnight of today + N in the tenant zone.
describe('resolveBookingWindow — minimum notice (0059)', () => {
  const CDMX = 'America/Mexico_City'; // UTC-6, no DST
  const NOW = Date.parse('2026-09-02T15:00:00Z'); // 09:00 Wednesday in CDMX
  const TOMORROW_MIDNIGHT = Date.parse('2026-09-03T06:00:00Z'); // 00:00 Thursday CDMX

  it('earliestBookableMs: 1 day = local midnight of tomorrow, not now + 24h', () => {
    expect(earliestBookableMs(NOW, 1, CDMX)).toBe(TOMORROW_MIDNIGHT);
    expect(earliestBookableMs(NOW, 1, CDMX)).not.toBe(NOW + DAY);
  });

  it('earliestBookableMs: null / 0 → no floor', () => {
    expect(earliestBookableMs(NOW, null, CDMX)).toBeNull();
    expect(earliestBookableMs(NOW, 0, CDMX)).toBeNull();
  });

  it('earliestBookableMs: the local day is what counts, even late at night', () => {
    // 23:30 Wednesday CDMX is already Thursday in UTC — the floor must still be Thursday 00:00 local.
    const late = Date.parse('2026-09-03T05:30:00Z');
    expect(earliestBookableMs(late, 1, CDMX)).toBe(TOMORROW_MIDNIGHT);
  });

  it('earliestBookableMs: crosses a month end', () => {
    const sep30 = Date.parse('2026-09-30T15:00:00Z');
    expect(earliestBookableMs(sep30, 1, CDMX)).toBe(Date.parse('2026-10-01T06:00:00Z'));
  });

  it('lifts a same-day `from` to the floor and counts the default 7 days from there', () => {
    const w = resolveBookingWindow(NOW, undefined, undefined, null, CDMX, 1);
    expect(w.fromMs).toBe(TOMORROW_MIDNIGHT);
    expect(w.liftedFrom).toBe(true);
    expect(w.minMs).toBe(TOMORROW_MIDNIGHT);
    expect(w.toMs).toBe(TOMORROW_MIDNIGHT + SEVEN_DAYS_MS);
    expect(w.tooSoon).toBe(false);
  });

  it('a range that ends before the floor (the model asked for today) is tooSoon', () => {
    const w = resolveBookingWindow(NOW, '2026-09-02T09:00:00', '2026-09-02T18:00:00', null, CDMX, 1);
    expect(w.tooSoon).toBe(true);
    expect(w.minMs).toBe(TOMORROW_MIDNIGHT);
  });

  it('a range starting tomorrow is untouched', () => {
    const w = resolveBookingWindow(NOW, '2026-09-03T00:00:00', '2026-09-05T00:00:00', null, CDMX, 1);
    expect(w.liftedFrom).toBe(false);
    expect(w.tooSoon).toBe(false);
    expect(w.fromMs).toBe(TOMORROW_MIDNIGHT);
  });

  it('composes with the horizon: floor on the near side, cap on the far side', () => {
    const w = resolveBookingWindow(NOW, undefined, undefined, 3, CDMX, 1);
    expect(w.fromMs).toBe(TOMORROW_MIDNIGHT);
    expect(w.toMs).toBe(NOW + 3 * DAY);
    expect(w.clamped).toBe(true);
  });

  it('no minimum notice → same behaviour as before (from = now)', () => {
    const w = resolveBookingWindow(NOW, undefined, undefined, null, CDMX, null);
    expect(w.fromMs).toBe(NOW);
    expect(w.minMs).toBeNull();
    expect(w.liftedFrom).toBe(false);
  });
});
