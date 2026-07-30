import { describe, it, expect } from 'vitest';
import { resolveBookingWindow, SEVEN_DAYS_MS } from './booking-window.js';

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
