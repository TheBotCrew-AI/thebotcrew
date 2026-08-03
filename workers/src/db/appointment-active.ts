/**
 * Pure "is this appointment active?" predicate, kept separate from the DB query so it
 * can be unit-tested (Layer 1, no DB).
 *
 * "Active" for the purpose of the front-desk self-block guard = NOT cancelled AND its
 * start time is still in the future. Past appointments never count: a contact may book
 * several times over a year, and a bygone appointment must not block a fresh booking.
 */

export interface AppointmentLike {
  action: string;
  appointmentDatetime: string | null;
}

export function isAppointmentActive(appt: AppointmentLike | null, nowMs: number): boolean {
  if (!appt) return false;
  if (appt.action === 'cancelled') return false;
  if (!appt.appointmentDatetime) return false;
  const startMs = Date.parse(appt.appointmentDatetime);
  if (Number.isNaN(startMs)) return false;
  return startMs > nowMs;
}

/** One row of the append-only `appointments` event log (see loadAppointmentLog). */
export interface AppointmentLogRow {
  ghlAppointmentId: string;
  action: string;
  appointmentDatetime: string | null;
  serviceType: string | null;
  createdAt: string;
}

/**
 * Collapse the append-only log into current state and pick "the lead's next
 * appointment": latest action per GHL appointment id wins (a later 'cancelled'
 * or 'rescheduled' row supersedes the original 'booked'), then among the still
 * active (future, non-cancelled) ones the SOONEST start time — not the most
 * recently created row, which is what bit the 2026-08-02 MADI test: two future
 * citas existed and the newest-created (the later one) shadowed the one the
 * lead was actually confirming. `rows` must be newest-first (the query's order).
 */
export function soonestUpcomingAppointment(rows: AppointmentLogRow[], nowMs: number): AppointmentLogRow | null {
  const latestById = new Map<string, AppointmentLogRow>();
  for (const r of rows) {
    if (!latestById.has(r.ghlAppointmentId)) latestById.set(r.ghlAppointmentId, r);
  }
  let best: { row: AppointmentLogRow; startMs: number } | null = null;
  for (const row of latestById.values()) {
    if (!isAppointmentActive(row, nowMs)) continue;
    const startMs = Date.parse(row.appointmentDatetime!);
    if (!best || startMs < best.startMs) best = { row, startMs };
  }
  return best?.row ?? null;
}
