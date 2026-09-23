/**
 * hold-reminder — when the ONE pre-deadline reminder of a paid hold goes out (0065).
 *
 * Not a fixed hour: an instant derived from the hold's own deadline and moved so it
 * never lands in the quiet window (default 21:00–08:00, in the clock the lead reads).
 *
 *   target = deadline − hoursBefore (default 3 h)
 *   • target inside quiet hours → the last moment BEFORE the window opens, minus a
 *     small margin (20:30 for a 21:00 window): a heads-up the evening before beats
 *     one at 5 a.m. and one that arrives after the deadline.
 *   • if that is too early (the hold was just created) → the moment the window ends
 *     (08:00), if it still leaves ≥ `minLeadMs` before the deadline.
 *   • never earlier than `created + minAfterCreateMs` (the link JUST arrived) and
 *     never later than `deadline − minLeadMs` (no time left to act on it).
 *   • nothing fits → null: no reminder. A same-afternoon cita doesn't need one.
 *
 * Pure and timezone-aware, like `core/active-hours.ts`, so the table of cases in
 * the test is the spec.
 */

import { DEFAULT_QUIET_HOURS, type QuietHours } from '../core/active-hours.js';

const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

export interface HoldReminderInput {
  /** When the hold was created (ms). */
  createdMs: number;
  /** The payment deadline (ms) — `booking_holds.due_at`. */
  dueMs: number;
  /** The clock the lead reads (lead's zone when known, else the tenant's). */
  timeZone: string;
  quietHours?: QuietHours | null;
  /** `booking_payment.reminder_hours_before`; 0 or less = no reminder. */
  hoursBefore: number;
  /** Don't remind sooner than this after creation. Default 1 h. */
  minAfterCreateMs?: number;
  /** A reminder must leave at least this long before the deadline. Default 1 h. */
  minLeadMs?: number;
  /** How long before the quiet window starts an evening reminder goes out. Default 30 min. */
  eveningMarginMs?: number;
}

/** Local hour + minutes of an instant in `timeZone`, as fractional hours. */
function localHourFrac(ms: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(ms));
  const get = (t: string): number => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const h = get('hour') % 24;
  return h + get('minute') / 60;
}

function localDateParts(ms: number, timeZone: string): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(ms));
  const get = (t: string): number => Number(parts.find((p) => p.type === t)?.value);
  return { year: get('year'), month: get('month'), day: get('day') };
}

/** The UTC instant of a local wall-clock time (fractional hour) on a local date, in `timeZone`. */
function zonedWallToMs(year: number, month: number, day: number, hourFrac: number, timeZone: string): number {
  const wholeHour = Math.floor(hourFrac);
  const minutes = Math.round((hourFrac - wholeHour) * 60);
  const guess = Date.UTC(year, month - 1, day, wholeHour, minutes, 0);
  const local = new Date(new Date(guess).toLocaleString('en-US', { timeZone })).getTime();
  const utc = new Date(new Date(guess).toLocaleString('en-US', { timeZone: 'UTC' })).getTime();
  return guess - (local - utc);
}

function inQuiet(hourFrac: number, quiet: QuietHours): boolean {
  if (quiet.start === quiet.end) return false;
  return quiet.start < quiet.end
    ? hourFrac >= quiet.start && hourFrac < quiet.end
    : hourFrac >= quiet.start || hourFrac < quiet.end;
}

export function holdReminderAt(input: HoldReminderInput): number | null {
  const quiet = input.quietHours ?? DEFAULT_QUIET_HOURS;
  const minAfterCreate = input.minAfterCreateMs ?? HOUR_MS;
  const minLead = input.minLeadMs ?? HOUR_MS;
  const eveningMargin = input.eveningMarginMs ?? 30 * MINUTE_MS;
  if (!(input.hoursBefore > 0)) return null;

  const earliest = input.createdMs + minAfterCreate;
  const latest = input.dueMs - minLead;
  if (earliest > latest) return null;

  const fits = (ms: number): boolean => ms >= earliest && ms <= latest;
  const target = input.dueMs - input.hoursBefore * HOUR_MS;

  // Whatever the target, it can't precede `earliest`: clamp up first, then check the window.
  const candidate = Math.max(target, earliest);
  if (!inQuiet(localHourFrac(candidate, input.timeZone), quiet)) {
    return fits(candidate) ? candidate : null;
  }

  // Inside the quiet window: prefer the evening before it opened…
  const { year, month, day } = localDateParts(candidate, input.timeZone);
  const hourNow = localHourFrac(candidate, input.timeZone);
  // The window that contains `candidate` opened today (late-night hours) or yesterday (small hours).
  const openedOnPrevDay = quiet.start > quiet.end && hourNow < quiet.end;
  const openDate = new Date(Date.UTC(year, month - 1, day));
  if (openedOnPrevDay) openDate.setUTCDate(openDate.getUTCDate() - 1);
  const evening = zonedWallToMs(openDate.getUTCFullYear(), openDate.getUTCMonth() + 1, openDate.getUTCDate(), quiet.start, input.timeZone) - eveningMargin;
  if (fits(evening)) return evening;

  // …else the morning the window closes.
  const closeDate = new Date(Date.UTC(year, month - 1, day));
  if (!openedOnPrevDay && quiet.start > quiet.end) closeDate.setUTCDate(closeDate.getUTCDate() + 1);
  const morning = zonedWallToMs(closeDate.getUTCFullYear(), closeDate.getUTCMonth() + 1, closeDate.getUTCDate(), quiet.end, input.timeZone);
  return fits(morning) ? morning : null;
}
