/**
 * "Does this lead hold an upcoming appointment?" — the help-mode predicate (0049).
 *
 * While the answer is yes, the bot is support, not sales: reactivation nudges
 * stay off and the front-desk prompt switches to modo asistencia. The hard part
 * is WHERE the answer lives: our `appointments` store only ever sees what the
 * bot itself booked. A package customer's next appointment is usually created by
 * staff directly in the GHL calendar — no webhook mirrors it — so the store is
 * either empty or holds a stale, already-past row for exactly the leads this
 * gate matters most for. Hence store-first (free), GHL-fallback (one API call).
 *
 * Failure direction: GhlClient.getContactAppointments returns [] on any HTTP
 * failure, so a transient GHL error reads as "no appointment" — at worst one
 * nudge reaches a booked customer. Never fails toward silencing the bot.
 */

import { soonestUpcomingAppointment } from './appointment-active.js';
import { loadAppointmentLog } from './queries.js';

/** The slice of GhlClient this predicate needs (kept narrow for tests). */
export interface ContactAppointmentsSource {
  getContactAppointments(
    contactId: string,
  ): Promise<Array<{ id: string; startTime?: string; status?: string; title?: string; deleted?: boolean }>>;
}

export interface UpcomingAppointment {
  startTime: string;
  service?: string;
}

/**
 * Resolve the lead's soonest upcoming (future, non-cancelled) appointment, or null.
 *
 * - Store has an upcoming one → returned, no API call (the self-block fast path).
 *   The event log is collapsed first (soonestUpcomingAppointment), so a lead with
 *   several future citas gets the NEXT one, and a later cancel/reschedule row
 *   supersedes the original booking.
 * - Store has history but nothing upcoming → ask GHL: this contact knows us, so a
 *   staff-booked next appointment (the package flow) is likely and worth a call.
 * - No store rows at all → null without an API call, unless `alwaysCheckGhl` —
 *   the follow-up runner sets it because a nudge is exactly the moment a
 *   walk-in's staff-booked appointment (zero store presence) must be caught.
 */
export async function findUpcomingAppointment(
  clientId: string,
  ghlContactId: string,
  ghl: ContactAppointmentsSource,
  nowMs: number,
  opts: { alwaysCheckGhl?: boolean } = {},
): Promise<UpcomingAppointment | null> {
  const log = await loadAppointmentLog(clientId, ghlContactId);
  const stored = soonestUpcomingAppointment(log, nowMs);
  if (stored) {
    // soonestUpcomingAppointment guarantees a valid future appointmentDatetime.
    return { startTime: stored.appointmentDatetime!, service: stored.serviceType ?? undefined };
  }
  if (log.length === 0 && !opts.alwaysCheckGhl) return null;

  const events = await ghl.getContactAppointments(ghlContactId);
  const upcoming = events
    .filter((e) => !e.deleted && e.status !== 'cancelled')
    .map((e) => ({ ...e, startMs: e.startTime ? Date.parse(e.startTime) : NaN }))
    .filter((e) => !Number.isNaN(e.startMs) && e.startMs > nowMs)
    .sort((a, b) => a.startMs - b.startMs)[0];
  if (!upcoming) return null;
  return { startTime: upcoming.startTime!, service: upcoming.title };
}
