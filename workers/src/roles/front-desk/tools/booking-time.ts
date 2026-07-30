/**
 * Pure time-resolution for bookAppointment. Kept separate from the tool so it can be
 * unit-tested (Layer 1, no network).
 *
 * WHY THIS EXISTS: the model builds the `startTime` string it hands to bookAppointment and
 * is NOT reliable at preserving the timezone offset. It dropped the `-07:00` from a slot
 * (`2026-07-08T17:15:00-07:00` → `2026-07-08T17:15:00`); GHL then read the offset-less string
 * as UTC and booked the appointment 7 hours off (a lead who asked for 5:15 p.m. Tijuana got
 * 10:15 a.m.). So we never trust the raw string as an instant. We re-query real availability
 * and book the exact, offset-correct slot string GHL returned that matches the WALL-CLOCK time
 * the lead picked (in the tenant's timezone) — the same frame getAvailability's labels use.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** True when the ISO string carries an explicit timezone (`Z` or `±HH:MM` / `±HHMM`). */
export function hasTimezoneOffset(iso: string): boolean {
  return /(?:Z|[+-]\d{2}:?\d{2})$/.test(iso.trim());
}

/**
 * The leading wall-clock of an ISO-ish string as `YYYY-MM-DDTHH:mm`, ignoring any offset.
 * Returns null if the string doesn't start with a parseable date-time.
 */
export function wallClockKey(iso: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(iso.trim());
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}`;
}

/**
 * Render an instant's wall-clock in a given IANA timezone as `YYYY-MM-DDTHH:mm`.
 * This is the tenant-tz frame getAvailability formats its labels in, so matching a slot's
 * key against the lead's requested wall-clock is offset-safe. Returns null on a bad instant.
 */
export function slotWallKey(iso: string, timeZone: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).formatToParts(d);
    const p: Record<string, string> = {};
    for (const part of parts) p[part.type] = part.value;
    if (!p.year || !p.month || !p.day || p.hour == null || p.minute == null) return null;
    return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
  } catch {
    return null;
  }
}

/**
 * The UTC instant for a wall-clock time in `timeZone`, found iteratively: measure the
 * guess's wall-clock, correct by the difference. Converges in ≤2 steps for real-world
 * offsets and needs no timezone database.
 */
export function zonedWallClockToMs(
  year: number, month: number, day: number, hour: number, minute: number, timeZone: string,
): number {
  const target = Date.UTC(year, month - 1, day, hour, minute);
  let t = target;
  for (let i = 0; i < 2; i++) {
    const key = slotWallKey(new Date(t).toISOString(), timeZone);
    if (!key) return target;
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(key);
    if (!m) return target;
    const measured = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!);
    t += target - measured;
  }
  return t;
}

/**
 * The instant a model-supplied date actually means.
 *
 * With an explicit offset → that instant. WITHOUT one → the wall-clock read in the
 * TENANT's timezone, never UTC. Same failure this file exists for, one level up: the
 * model writes "el sábado" as `2026-08-01T00:00:00`, and reading that as UTC shifts the
 * whole availability window by the tenant's offset — silently truncating a day's real
 * slots (or claiming a range is out of horizon when it isn't).
 */
export function requestedInstantMs(
  iso: string | undefined,
  timeZone: string,
  fallbackMs: number,
): number {
  if (!iso) return fallbackMs;
  if (hasTimezoneOffset(iso)) {
    const t = Date.parse(iso);
    return Number.isNaN(t) ? fallbackMs : t;
  }
  const key = wallClockKey(iso);
  if (!key) return fallbackMs;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(key);
  if (!m) return fallbackMs;
  return zonedWallClockToMs(+m[1]!, +m[2]!, +m[3]!, +m[4]!, +m[5]!, timeZone);
}

/**
 * Coarse UTC anchor for the requested time, used only to bound the availability re-query.
 * We interpret the wall-clock as if it were UTC (or honour an explicit offset) purely to pick
 * a query window — the true instant is within a few hours of it, so callers pad by ±1 day.
 */
export function requestAnchorMs(startTime: string, nowMs: number): number {
  if (hasTimezoneOffset(startTime)) {
    const t = Date.parse(startTime);
    if (!Number.isNaN(t)) return t;
  }
  const key = wallClockKey(startTime);
  if (key) {
    const t = Date.parse(`${key}:00Z`);
    if (!Number.isNaN(t)) return t;
  }
  return nowMs;
}

/**
 * The availability query window that is guaranteed to contain the requested slot. The real
 * instant is within one max-timezone-offset (<14h) of the UTC-interpreted anchor, so ±1 day
 * covers it. `from` never precedes `now` (GHL rejects past ranges).
 */
export function bookingQueryWindow(
  startTime: string,
  nowMs: number,
): { fromMs: number; toMs: number } {
  const anchor = requestAnchorMs(startTime, nowMs);
  return { fromMs: Math.max(nowMs, anchor - DAY_MS), toMs: anchor + DAY_MS };
}

export interface AvailabilitySlot {
  start: string;
  end: string;
}

/**
 * Find the real slot the lead asked for and return its canonical, offset-correct `start`
 * string (the one GHL itself returned) — never the model's re-typed string.
 *
 * Matching depends on whether the request carries a timezone:
 *   - WITH an explicit offset → trust it as an instant; match the slot at the same instant.
 *     No wall-clock fallback, so a correct-but-UTC-expressed time can't be mis-matched to a
 *     same-digits local slot.
 *   - WITHOUT an offset (the bug class) → the digits are the local wall-clock the lead picked;
 *     match the slot whose tenant-tz wall-clock equals them.
 *
 * Returns null when no offered slot matches (hallucinated / stale / already-taken time, or a
 * correct instant that simply isn't on the board), so the caller refuses the booking instead
 * of inventing one.
 */
export function resolveBookableSlot(
  slots: readonly AvailabilitySlot[],
  requestedStart: string,
  timeZone: string,
): string | null {
  if (hasTimezoneOffset(requestedStart)) {
    const reqEpoch = Date.parse(requestedStart);
    if (Number.isNaN(reqEpoch)) return null;
    for (const s of slots) {
      const se = Date.parse(s.start);
      if (!Number.isNaN(se) && se === reqEpoch) return s.start;
    }
    return null;
  }

  const reqWall = wallClockKey(requestedStart);
  if (!reqWall) return null;
  for (const s of slots) {
    if (slotWallKey(s.start, timeZone) === reqWall) return s.start;
  }
  return null;
}
