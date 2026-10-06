/**
 * GHL's contact-appointments list (`GET /contacts/{id}/appointments`) returns `startTime`
 * as a bare wall-clock in the calendar's timezone — `"2026-10-06 08:00:00"`, no offset.
 * Read as-is, `Date.parse` and Postgres both take it as UTC, which shifts every time by
 * the tenant's offset (8:00 a.m. Tijuana becomes 1:00 a.m.). This turns it into an
 * offset-carrying instant, reading the wall-clock in the tenant's timezone.
 *
 * Assumes the calendar shares the tenant's timezone; reading each calendar's own zone
 * would cost a GHL call per appointment.
 */

import { hasTimezoneOffset, zonedWallClockToMs } from '../roles/front-desk/tools/booking-time.js';

/** ISO instant (UTC, `Z`) for a GHL appointment time. A string that already carries an
 *  offset passes through unchanged; one that isn't a recognizable date-time is returned
 *  undefined rather than guessed at. */
export function ghlAppointmentInstant(raw: string | undefined, timeZone: string): string | undefined {
  if (!raw) return undefined;
  const s = raw.trim();
  if (hasTimezoneOffset(s)) return Number.isNaN(Date.parse(s)) ? undefined : s;
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (!m) return undefined;
  const ms = zonedWallClockToMs(+m[1]!, +m[2]!, +m[3]!, +m[4]!, +m[5]!, timeZone) + (m[6] ? +m[6] * 1000 : 0);
  return new Date(ms).toISOString();
}
