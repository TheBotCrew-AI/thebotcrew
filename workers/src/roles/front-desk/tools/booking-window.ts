/**
 * Pure resolution of the availability query window, with a deterministic per-tenant
 * booking horizon. Kept separate from the tool so it can be unit-tested (Layer 1).
 *
 * - Clamps `from` to never be in the past.
 * - Clamps `to` to `now + horizonDays` (the business rule), so the tool never even
 *   asks GHL for slots past the horizon.
 * - Flags `outOfHorizon` when the whole requested range starts past the horizon, so
 *   the tool can tell the agent to redirect the lead instead of querying.
 */

import { requestedInstantMs } from './booking-time.js';

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
}

export function resolveBookingWindow(
  now: number,
  fromDate: string | undefined,
  toDate: string | undefined,
  horizonDays: number | null | undefined,
  /** Tenant timezone. An offset-less date from the model is read as LOCAL wall-clock in
   *  this zone — reading it as UTC shifts the window and silently truncates real slots. */
  timeZone = 'UTC',
): BookingWindow {
  let fromMs = requestedInstantMs(fromDate, timeZone, now);
  if (Number.isNaN(fromMs) || fromMs < now) fromMs = now;
  let toMs = requestedInstantMs(toDate, timeZone, now + SEVEN_DAYS_MS);
  if (Number.isNaN(toMs)) toMs = now + SEVEN_DAYS_MS;

  if (horizonDays == null) {
    return { fromMs, toMs, outOfHorizon: false, maxMs: null, clamped: false };
  }

  const maxMs = now + horizonDays * DAY_MS;
  if (fromMs > maxMs) {
    return { fromMs, toMs, outOfHorizon: true, maxMs, clamped: false };
  }
  if (toMs > maxMs) {
    return { fromMs, toMs: maxMs, outOfHorizon: false, maxMs, clamped: true };
  }
  return { fromMs, toMs, outOfHorizon: false, maxMs, clamped: false };
}
