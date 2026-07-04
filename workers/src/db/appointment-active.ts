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
