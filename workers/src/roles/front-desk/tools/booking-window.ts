/**
 * Pure resolution of the availability query window, with a deterministic per-tenant
 * booking horizon. Kept separate from the tool so it can be unit-tested (Layer 1).
 *
 * - Clamps `from` to never be in the past.
 * - Clamps `from` up to the minimum notice (the near-side business rule): with
 *   `minNoticeDays = 1` nothing before local midnight of tomorrow is ever queried, so
 *   the bot cannot offer a same-day slot no matter what the model asks for.
 * - Clamps `to` to `now + horizonDays` (the far-side business rule), so the tool never
 *   even asks GHL for slots past the horizon.
 * - Flags `tooSoon` when the whole requested range ends before the minimum notice, and
 *   `outOfHorizon` when it starts past the horizon, so the tool can tell the agent to
 *   redirect the lead instead of querying.
 */

import { requestedInstantMs, slotWallKey, zonedWallClockToMs } from './booking-time.js';

export const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface BookingWindow {
  fromMs: number;
  toMs: number;
  /** True when the requested start is already past the horizon → nothing to offer. */
  outOfHorizon: boolean;
  /** Horizon boundary in ms, or null when the tenant has no cap. */
  maxMs: number | null;
  /** True when `to` was clamped down to the horizon. */
  clamped: boolean;
  /** True when the requested range ends before the minimum notice → nothing to offer. */
  tooSoon: boolean;
  /** Earliest bookable instant in ms (local midnight of today + minNoticeDays), or null. */
  minMs: number | null;
  /** True when `from` was lifted up to the minimum notice. */
  liftedFrom: boolean;
}

/**
 * The earliest instant the tenant accepts a booking for: local midnight, in `timeZone`,
 * of today + `minNoticeDays`. A calendar-day floor, not a 24-hour one — "solo a partir de
 * mañana" means tomorrow's first slot is fine even when it is fewer than 24 h away.
 * null when the tenant has no minimum notice (same-day booking allowed).
 */
export function earliestBookableMs(now: number, minNoticeDays: number | null | undefined, timeZone: string): number | null {
  if (minNoticeDays == null || minNoticeDays <= 0) return null;
  const key = slotWallKey(new Date(now).toISOString(), timeZone);
  const m = key ? /^(\d{4})-(\d{2})-(\d{2})T/.exec(key) : null;
  if (!m) {
    // Unknown zone: fall back to UTC calendar days rather than silently allowing today.
    const d = new Date(now);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + minNoticeDays);
  }
  // Date.UTC normalises day overflow (Sept 31 → Oct 1), so month ends need no special case.
  return zonedWallClockToMs(+m[1]!, +m[2]!, +m[3]! + minNoticeDays, 0, 0, timeZone);
}

export function resolveBookingWindow(
  now: number,
  fromDate: string | undefined,
  toDate: string | undefined,
  horizonDays: number | null | undefined,
  /** Tenant timezone. An offset-less date from the model is read as LOCAL wall-clock in
   *  this zone — reading it as UTC shifts the window and silently truncates real slots. */
  timeZone = 'UTC',
  minNoticeDays: number | null | undefined = null,
): BookingWindow {
  let fromMs = requestedInstantMs(fromDate, timeZone, now);
  if (Number.isNaN(fromMs) || fromMs < now) fromMs = now;

  const minMs = earliestBookableMs(now, minNoticeDays, timeZone);
  let liftedFrom = false;
  let tooSoon = false;
  let toMs = requestedInstantMs(toDate, timeZone, NaN);
  if (minMs != null) {
    // A range that ends before the floor (the model asked for today) has nothing to offer.
    if (!Number.isNaN(toMs) && toMs <= minMs) tooSoon = true;
    if (fromMs < minMs) {
      fromMs = minMs;
      liftedFrom = true;
    }
  }
  // The default range is counted from the (possibly lifted) start, so a minimum notice
  // never eats into the seven days of slots the model gets to choose from.
  if (Number.isNaN(toMs)) toMs = fromMs + SEVEN_DAYS_MS;

  const base = { fromMs, toMs, tooSoon, minMs, liftedFrom };
  if (horizonDays == null) {
    return { ...base, outOfHorizon: false, maxMs: null, clamped: false };
  }

  const maxMs = now + horizonDays * DAY_MS;
  if (fromMs > maxMs) {
    return { ...base, outOfHorizon: true, maxMs, clamped: false };
  }
  if (toMs > maxMs) {
    return { ...base, toMs: maxMs, outOfHorizon: false, maxMs, clamped: true };
  }
  return { ...base, outOfHorizon: false, maxMs, clamped: false };
}
