import { describe, it, expect } from 'vitest';
import { closedRange, dayListEs, openDaysEs, openWeekdays, weekdayKeyInZone, weekdaysInRange } from './open-days.js';

const TZ = 'America/Chihuahua'; // -06:00, no DST since 2022
const MON_FRI = {
  mon: [{ open: '10:30', close: '12:30' }],
  tue: [{ open: '10:30', close: '12:30' }],
  wed: [{ open: '10:30', close: '12:30' }],
  thu: [{ open: '10:30', close: '12:30' }],
  fri: [{ open: '10:30', close: '12:30' }],
};

/** Local wall-clock midnight in Chihuahua is 06:00Z. */
const localMidnight = (day: string) => Date.parse(`${day}T06:00:00Z`);

describe('weekdayKeyInZone', () => {
  it('reads the weekday in the business clock, not UTC', () => {
    // 2026-09-27T02:00Z is still Saturday the 26th at 20:00 in Chihuahua.
    expect(weekdayKeyInZone(Date.parse('2026-09-27T02:00:00Z'), TZ)).toBe('sat');
    expect(weekdayKeyInZone(Date.parse('2026-09-27T02:00:00Z'), 'UTC')).toBe('sun');
  });

  it('returns null for an unusable zone instead of guessing a day', () => {
    expect(weekdayKeyInZone(Date.now(), 'Not/AZone')).toBeNull();
  });
});

describe('weekdaysInRange', () => {
  it('a single local day → that day only; midnight end does NOT drag the next day in', () => {
    // The shape the model writes for "el sábado": Sat 00:00 → Sun 00:00 local.
    expect(weekdaysInRange(localMidnight('2026-09-26'), localMidnight('2026-09-27'), TZ)).toEqual(['sat']);
  });

  it('a weekend range covers both days', () => {
    expect(weekdaysInRange(localMidnight('2026-09-26'), localMidnight('2026-09-28'), TZ)!.sort()).toEqual(['sat', 'sun']);
  });

  it('an afternoon inside one day still resolves that day (shorter than the walk step)', () => {
    const from = Date.parse('2026-09-26T21:00:00Z'); // 15:00 Sat local
    expect(weekdaysInRange(from, from + 60 * 60 * 1000, TZ)).toEqual(['sat']);
  });

  it('an empty or inverted range is not enumerable', () => {
    const t = localMidnight('2026-09-26');
    expect(weekdaysInRange(t, t, TZ)).toBeNull();
    expect(weekdaysInRange(t + 1000, t, TZ)).toBeNull();
  });

  it('a range too long to be all-closed gives up rather than walking forever', () => {
    expect(weekdaysInRange(localMidnight('2026-09-01'), localMidnight('2026-12-01'), TZ)).toBeNull();
  });
});

describe('openWeekdays', () => {
  it('lists configured days in week order, ignoring the config key order', () => {
    expect(openWeekdays({ fri: [{ open: '9', close: '5' }], mon: [{ open: '9', close: '5' }] })).toEqual(['mon', 'fri']);
  });

  it('a day configured with zero intervals is closed', () => {
    expect(openWeekdays({ ...MON_FRI, sat: [] })).toEqual(['mon', 'tue', 'wed', 'thu', 'fri']);
  });
});

describe('closedRange', () => {
  it('Saturday on a Mon–Fri business → closed, with the open days to offer instead', () => {
    const res = closedRange(localMidnight('2026-09-26'), localMidnight('2026-09-27'), TZ, MON_FRI);
    expect(res).toEqual({ closed: ['sat'], open: ['mon', 'tue', 'wed', 'thu', 'fri'] });
  });

  it('a weekend range names both closed days, in week order', () => {
    const res = closedRange(localMidnight('2026-09-26'), localMidnight('2026-09-28'), TZ, MON_FRI);
    expect(res?.closed).toEqual(['sat', 'sun']);
  });

  // The whole point of "entirely": Friday's real slots are the answer to a Fri–Sat range.
  it('a range that touches ONE open day is not closed', () => {
    expect(closedRange(localMidnight('2026-09-25'), localMidnight('2026-09-27'), TZ, MON_FRI)).toBeNull();
  });

  it('the default 7-day range is never closed', () => {
    const from = localMidnight('2026-09-26');
    expect(closedRange(from, from + 7 * 86_400_000, TZ, MON_FRI)).toBeNull();
  });

  // An unconfigured schedule is UNKNOWN, not closed — gating on it would have an
  // onboarding-stage tenant tell every lead it never opens.
  it('a tenant with no hours configured is never gated', () => {
    expect(closedRange(localMidnight('2026-09-26'), localMidnight('2026-09-27'), TZ, {})).toBeNull();
    expect(closedRange(localMidnight('2026-09-26'), localMidnight('2026-09-27'), TZ, { sat: [] })).toBeNull();
  });

  it('a business open all seven days is never gated', () => {
    const day = [{ open: '09:00', close: '18:00' }];
    const week = { mon: day, tue: day, wed: day, thu: day, fri: day, sat: day, sun: day };
    expect(closedRange(localMidnight('2026-09-26'), localMidnight('2026-09-27'), TZ, week)).toBeNull();
  });

  // The days are the BUSINESS's: a lead's Saturday can be the clinic's open Friday evening.
  it('resolves the day in the business zone, not in UTC', () => {
    // Friday 23:30 in Chihuahua is already Saturday 05:30 in UTC: read in UTC the clinic
    // would refuse an hour it is actually open.
    const fri2330 = Date.parse('2026-09-26T05:30:00Z');
    expect(closedRange(fri2330, fri2330 + 20 * 60 * 1000, TZ, MON_FRI)).toBeNull();
    expect(closedRange(fri2330, fri2330 + 20 * 60 * 1000, 'UTC', MON_FRI)).not.toBeNull();
  });
});

describe('prose helpers', () => {
  it('dayListEs joins with "y"', () => {
    expect(dayListEs(['sat'])).toBe('sábado');
    expect(dayListEs(['sat', 'sun'])).toBe('sábado y domingo');
    expect(dayListEs(['sat', 'sun', 'mon'])).toBe('sábado, domingo y lunes');
  });

  it('openDaysEs collapses a contiguous run and lists the rest', () => {
    expect(openDaysEs(['mon', 'tue', 'wed', 'thu', 'fri'])).toBe('de lunes a viernes');
    expect(openDaysEs(['mon', 'wed', 'fri'])).toBe('lunes, miércoles y viernes');
    expect(openDaysEs(['mon', 'tue'])).toBe('lunes y martes');
  });
});
