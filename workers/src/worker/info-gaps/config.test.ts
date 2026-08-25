import { describe, it, expect } from 'vitest';
import { INFO_GAP_DEFAULTS, isRunDue, parseInfoGaps } from './config.js';

describe('parseInfoGaps', () => {
  it('is off for NULL, junk, and enabled:false', () => {
    expect(parseInfoGaps(null)).toBeNull();
    expect(parseInfoGaps('yes')).toBeNull();
    expect(parseInfoGaps([])).toBeNull();
    expect(parseInfoGaps({ enabled: false, min_candidates: 5 })).toBeNull();
    expect(parseInfoGaps({ min_candidates: 5 })).toBeNull();
  });

  it('fills the defaults and ignores non-positive or fractional values', () => {
    expect(parseInfoGaps({ enabled: true })).toEqual({ enabled: true, ...INFO_GAP_DEFAULTS });
    expect(parseInfoGaps({ enabled: true, min_candidates: 0, max_days: -1, min_for_time_run: 2.5 })).toEqual({
      enabled: true,
      ...INFO_GAP_DEFAULTS,
    });
    expect(parseInfoGaps({ enabled: true, min_candidates: 4, max_days: 14, min_for_time_run: 1 })).toEqual({
      enabled: true,
      minCandidates: 4,
      maxDays: 14,
      minForTimeRun: 1,
    });
  });
});

describe('isRunDue', () => {
  const cfg = { enabled: true, minCandidates: 10, maxDays: 7, minForTimeRun: 3 };
  const now = new Date('2026-08-25T13:00:00Z');
  const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000);

  it('runs on volume regardless of time', () => {
    expect(isRunDue(cfg, 10, daysAgo(1), now)).toBe(true);
    expect(isRunDue(cfg, 9, daysAgo(1), now)).toBe(false);
  });

  it('runs on time only with a minimum to look at', () => {
    expect(isRunDue(cfg, 3, daysAgo(7), now)).toBe(true);
    expect(isRunDue(cfg, 2, daysAgo(30), now)).toBe(false); // two conversations are an anecdote
    expect(isRunDue(cfg, 3, daysAgo(6), now)).toBe(false);
  });

  it('a tenant that never ran is due as soon as it has the minimum', () => {
    expect(isRunDue(cfg, 3, null, now)).toBe(true);
    expect(isRunDue(cfg, 2, null, now)).toBe(false);
  });
});
