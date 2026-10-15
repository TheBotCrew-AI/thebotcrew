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
    timeZone: string,
  ): Promise<Array<{ id: string; startTime?: string; status?: string; title?: string; deleted?: boolean }>>;
  /** One appointment, live. Optional so a source that can't read it keeps the store's answer. */
  getAppointment?(appointmentId: string): Promise<{ startTime?: string; status?: string; title?: string }>;
}

export interface UpcomingAppointment {
  startTime: string;
  service?: string;
}

/**
 * Resolve the lead's soonest upcoming (future, non-cancelled) appointment, or null.
 *
 * - Store has an upcoming one → verified live (one GHL read of THAT appointment) and
 *   returned at its live time. The store only hears about a staff cancel/move when the
 *   tenant's workflow posts it, and a row that outlived its appointment put the bot in
 *   modo asistencia for a lead whose cita GHL had cancelled — it told her she still had
 *   one and refused to offer slots (Heriberto, 2026-10-14). Cancelled live → treated as
 *   no store appointment, and GHL is asked for another. The read failing keeps the
 *   store's answer, same as lookupAppointment.
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
  timeZone: string,
  opts: { alwaysCheckGhl?: boolean } = {},
): Promise<UpcomingAppointment | null> {
  const log = await loadAppointmentLog(clientId, ghlContactId);
  const stored = soonestUpcomingAppointment(log, nowMs);
  if (stored) {
    // soonestUpcomingAppointment guarantees a valid future appointmentDatetime.
    const live = await readLive(ghl, stored.ghlAppointmentId);
    if (live !== 'cancelled') {
      return { startTime: live?.startTime ?? stored.appointmentDatetime!, service: stored.serviceType ?? undefined };
    }
  }
  if (log.length === 0 && !opts.alwaysCheckGhl) return null;

  const events = await ghl.getContactAppointments(ghlContactId, timeZone);
  const upcoming = events
    .filter((e) => !e.deleted && e.status !== 'cancelled')
    .map((e) => ({ ...e, startMs: e.startTime ? Date.parse(e.startTime) : NaN }))
    .filter((e) => !Number.isNaN(e.startMs) && e.startMs > nowMs)
    .sort((a, b) => a.startMs - b.startMs)[0];
  if (!upcoming) return null;
  return { startTime: upcoming.startTime!, service: upcoming.title };
}

/** The store row's appointment as GHL has it now: 'cancelled', its live fields, or null when unreadable. */
async function readLive(
  ghl: ContactAppointmentsSource,
  appointmentId: string,
): Promise<'cancelled' | { startTime?: string } | null> {
  if (!ghl.getAppointment) return null;
  try {
    const live = await ghl.getAppointment(appointmentId);
    if (live.status?.toLowerCase() === 'cancelled') return 'cancelled';
    return { startTime: live.startTime };
  } catch (e) {
    console.error('[upcoming-appointment] GHL read failed, trusting the store:', e instanceof Error ? e.message : String(e));
    return null;
  }
}
