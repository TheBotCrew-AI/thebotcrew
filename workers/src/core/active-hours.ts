/**
 * Quiet-hours (DND) clamping for follow-ups.
 *
 * We never want a scheduled reactivation message to fire in the middle of the
 * night. If a follow-up's computed send time falls inside the tenant's quiet
 * window, we push it forward to when the window ends (e.g. 08:00 local). Because
 * follow-ups are scheduled one tier at a time — each relative to when the previous
 * one actually sent — clamping a single tier naturally shifts the whole chain
 * forward; there is no cascading to handle here.
 *
 * Pure and timezone-aware so it can be unit-tested deterministically (Layer 1).
 */

export interface QuietHours {
  /** Local hour [0-23] when the quiet window starts (inclusive). */
  start: number;
  /** Local hour [0-23] when the quiet window ends (exclusive) — follow-ups resume here. */
  end: number;
}

/** Platform default: silent 21:00–08:00 local. Tenants may override via config. */
export const DEFAULT_QUIET_HOURS: QuietHours = { start: 21, end: 8 };

/** Local hour [0-23] of an instant in a given IANA timezone. */
function localHour(instant: Date, timeZone: string): number {
  const h = Number(
    new Intl.DateTimeFormat('en-US', { timeZone, hour: '2-digit', hour12: false }).format(instant),
  );
  return h === 24 ? 0 : h; // some environments render midnight as '24'
}

/** Local calendar date (year, month 1-12, day) of an instant in a timezone. */
function localDateParts(instant: Date, timeZone: string): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const get = (t: string): number => Number(parts.find((p) => p.type === t)?.value);
  return { year: get('year'), month: get('month'), day: get('day') };
}

/** Convert a local wall-clock time (in `timeZone`) to the matching UTC instant. */
function zonedWallToUtc(year: number, month: number, day: number, hour: number, timeZone: string): Date {
  const guess = Date.UTC(year, month - 1, day, hour, 0, 0);
  const local = new Date(new Date(guess).toLocaleString('en-US', { timeZone }));
  const utc = new Date(new Date(guess).toLocaleString('en-US', { timeZone: 'UTC' }));
  const offset = local.getTime() - utc.getTime();
  return new Date(guess - offset);
}

/** True when `hour` falls inside the quiet window (handles windows that cross midnight). */
function inQuietWindow(hour: number, quiet: QuietHours): boolean {
  if (quiet.start === quiet.end) return false; // empty window → no quiet period
  return quiet.start < quiet.end
    ? hour >= quiet.start && hour < quiet.end // same-day window
    : hour >= quiet.start || hour < quiet.end; // crosses midnight
}

/**
 * If `base` falls inside the tenant's quiet window, return the next window-end
 * (e.g. 08:00 local) as a UTC instant; otherwise return `base` unchanged.
 */
export function clampToActiveHours(
  base: Date,
  timeZone: string,
  quiet: QuietHours = DEFAULT_QUIET_HOURS,
): Date {
  const hour = localHour(base, timeZone);
  if (!inQuietWindow(hour, quiet)) return base;

  // Late-night hours (>= end) resume the following morning; early-morning hours
  // (< end) resume the same day.
  const { year, month, day } = localDateParts(base, timeZone);
  const resume = new Date(Date.UTC(year, month - 1, day));
  if (hour >= quiet.end) resume.setUTCDate(resume.getUTCDate() + 1);

  return zonedWallToUtc(resume.getUTCFullYear(), resume.getUTCMonth() + 1, resume.getUTCDate(), quiet.end, timeZone);
}
