/**
 * resolveActiveAppointment — find the contact's current appointment for the lookup /
 * reschedule / cancel tools.
 *
 * Our store only knows about appointments the BOT booked (via logAppointment). An
 * appointment created or moved directly in the GHL calendar (by the client's staff, or a
 * lead using GHL's own booking widget) never lands in our store, so a store-only lookup
 * reports "no tienes cita" even though GHL has one. This resolver reads our store first
 * (cheap, and the freshest source right after the bot books — the self-block window) and
 * falls back to GHL's own list of the contact's appointments when the store has none.
 *
 * The two sources return different keys, so callers branch on `source`:
 *   - store → `serviceType` is set (maps to a configured calendar); `calendarId` is null.
 *   - ghl   → `calendarId` is set (straight from GHL); `serviceType` is null.
 */

import type { GhlClient } from '../../../ghl/client.js';
import { soonestUpcomingAppointment } from '../../../db/appointment-active.js';
import { loadAppointmentLog } from '../../../db/queries.js';

export interface ResolvedAppointment {
  ghlAppointmentId: string;
  startTime: string | null;
  serviceType: string | null;
  calendarId: string | null;
  source: 'store' | 'ghl';
}

export async function resolveActiveAppointment(
  ghl: GhlClient,
  clientId: string,
  ghlContactId: string,
  nowMs: number,
): Promise<ResolvedAppointment | null> {
  // 1) Our store — bot bookings + workflow-webhook rows. The event log is collapsed
  //    to "the SOONEST upcoming appointment" (soonestUpcomingAppointment): a past
  //    store row used to win here unconditionally, which made the GHL fallback
  //    unreachable for exactly the contacts that need it — a package customer whose
  //    bot-booked first session already happened had lookup/reschedule/cancel
  //    operating on that bygone appointment while their staff-booked next one sat
  //    unseen in GHL. With several future citas, the next one is the lead's "mi cita".
  const stored = soonestUpcomingAppointment(await loadAppointmentLog(clientId, ghlContactId), nowMs);
  if (stored) {
    return {
      ghlAppointmentId: stored.ghlAppointmentId,
      startTime: stored.appointmentDatetime,
      serviceType: stored.serviceType,
      calendarId: null,
      source: 'store',
    };
  }

  // 2) GHL fallback — appointment booked/edited outside the bot. Pick the soonest upcoming
  //    one that isn't cancelled or deleted (mirrors isAppointmentActive: not cancelled, future).
  const events = await ghl.getContactAppointments(ghlContactId);
  const next = events
    .filter(
      (e) =>
        !e.deleted &&
        e.status?.toLowerCase() !== 'cancelled' &&
        !!e.startTime &&
        Date.parse(e.startTime) > nowMs,
    )
    .sort((a, b) => Date.parse(a.startTime!) - Date.parse(b.startTime!))[0];
  if (!next) return null;

  return {
    ghlAppointmentId: next.id,
    startTime: next.startTime ?? null,
    serviceType: null,
    calendarId: next.calendarId ?? null,
    source: 'ghl',
  };
}
