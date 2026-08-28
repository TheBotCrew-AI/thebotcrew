/**
 * rescheduleAppointment — move the contact's active appointment to a new time.
 *
 * Validates the new time against REAL availability (same anti-hallucination guard
 * as booking) before moving it, so the agent can't reschedule to a slot it made up
 * or one that is already taken. The agent must call getAvailability and offer real
 * slots first (see the prompt rules).
 */

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { GhlClient } from '../../../ghl/client.js';
import { getActiveDemoSession, logAppointment, logBotEvent, setSimulatedBooking } from '../../../db/queries.js';
import { resolveAgentContext } from './agent-context.js';
import { resolveActiveAppointment } from './resolve-appointment.js';
import { bookingQueryWindow, resolveBookableSlot } from './booking-time.js';
import { simSlotLabel, simulatedSlots } from './demo-sim.js';
import { slotLabel } from './slot-label.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export const rescheduleAppointmentTool = createTool({
  id: 'rescheduleAppointment',
  description:
    'Reagenda la cita activa del contacto a un nuevo horario. Úsala solo tras consultar getAvailability ' +
    'y ofrecer horarios reales; pásale un startTime que haya devuelto getAvailability. Si no hay cita ' +
    'activa, lo indica sin inventar.',
  inputSchema: z.object({
    startTime: z
      .string()
      .describe('Nuevo horario de inicio en ISO 8601, tomado EXACTAMENTE de un slot que devolvió getAvailability.'),
  }),
  outputSchema: z.object({
    rescheduled: z.boolean(),
    message: z.string(),
  }),
  execute: async ({ startTime }, ctx) => {
    const { tenant, turn, config, frameTz } = resolveAgentContext(ctx);

    // Demo mode: move the SIMULATED booking, with the same only-real-slots guard.
    if (turn.activeRole === 'demo') {
      const session = await getActiveDemoSession(turn.ghlConversationId).catch(() => null);
      const current = session?.simulatedBooking;
      if (!session || !current) {
        return { rescheduled: false, message: 'No encuentro una cita activa para reagendar.' };
      }
      const slots = simulatedSlots(turn.ghlConversationId, config.timezone, Date.now(), current.startTime);
      const resolved = resolveBookableSlot(slots, startTime, config.timezone);
      if (!resolved) {
        return {
          rescheduled: false,
          message: 'Ese horario no está disponible. Consulta getAvailability y ofrece solo los slots que devuelva.',
        };
      }
      const label = simSlotLabel(resolved, config.timezone);
      try {
        await setSimulatedBooking(session.id, { startTime: resolved, serviceName: current.serviceName, label });
      } catch (e) {
        console.error('[rescheduleAppointment] demo update failed (non-blocking):', e instanceof Error ? e.message : String(e));
      }
      return { rescheduled: true, message: `Cita reagendada: ${label}. Confírmala al lead con ese texto exacto.` };
    }

    const ghl = new GhlClient(tenant.tenantId);
    const appt = await resolveActiveAppointment(ghl, tenant.clientId, turn.ghlContactId, Date.now());
    if (!appt) {
      return { rescheduled: false, message: 'No encuentro una cita activa para reagendar.' };
    }

    // Resolve the calendar: store-sourced appts map serviceType→calendar; GHL-sourced carry
    // the calendarId directly. Reverse-map the calendarId back to a service name for the
    // duration + logging (null if it's a calendar we don't have configured).
    const calendarId = appt.calendarId ?? (appt.serviceType ? config.calendars[appt.serviceType] : undefined);
    if (!calendarId) {
      return { rescheduled: false, message: 'No pude identificar el calendario de la cita para reagendarla.' };
    }
    const serviceName =
      appt.serviceType ?? Object.keys(config.calendars).find((n) => config.calendars[n] === calendarId) ?? null;

    // Resolve the requested time the SAME way bookAppointment does. This tool used to
    // match by instant (`new Date(startTime).getTime()`) and then hand GHL the model's raw
    // string — which reopened the exact bug booking was hardened against on 2026-07-06.
    // Live on 2026-07-30: the lead asked for "viernes 4:00 p.m.", the model emitted
    // `2026-07-31T16:00:00` with the `-07:00` dropped, that parsed as 16:00 UTC, which is
    // a REAL free slot (9:00 a.m. Tijuana) — so the naive instant match passed and the
    // appointment moved to 9 a.m. Matching by tenant wall-clock makes a dropped offset
    // unrepresentable, and we send back the canonical, offset-carrying slot string.
    const now = Date.now();
    const { fromMs, toMs } = bookingQueryWindow(startTime, now);
    let canonicalStart: string;
    try {
      const slots = await ghl.getAvailability(
        calendarId,
        new Date(fromMs).toISOString(),
        new Date(toMs).toISOString(),
      );
      const resolved = resolveBookableSlot(slots, startTime, frameTz);
      if (!resolved) {
        await logBotEvent(tenant.clientId, turn.ghlConversationId, 'booking_failed', {
          stage: 'reschedule',
          serviceName,
          calendarId,
          startTime,
          reason: 'slot_unavailable',
        });
        return {
          rescheduled: false,
          message: 'Ese horario no está disponible. Consulta getAvailability y ofrece SOLO los horarios que devuelva.',
        };
      }
      canonicalStart = resolved;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[rescheduleAppointment] availability check failed:', msg);
      await logBotEvent(tenant.clientId, turn.ghlConversationId, 'booking_failed', {
        stage: 'reschedule_validate_availability',
        serviceName,
        calendarId,
        startTime,
        error: msg,
      });
      return { rescheduled: false, message: 'No pude verificar la disponibilidad en este momento. Intenta de nuevo.' };
    }

    // Horizon is enforced on the RESOLVED instant, not the model's string (same as booking).
    const horizon = config.bookingHorizonDays ?? null;
    if (horizon != null && Date.parse(canonicalStart) > now + horizon * DAY_MS) {
      await logBotEvent(tenant.clientId, turn.ghlConversationId, 'booking_failed', {
        stage: 'reschedule',
        serviceName,
        calendarId,
        startTime: canonicalStart,
        reason: 'out_of_horizon',
        horizonDays: horizon,
      });
      return {
        rescheduled: false,
        message: `Ese horario queda fuera de la ventana de agendado (${horizon} días). Ofrece un horario más cercano.`,
      };
    }

    // Optional endTime from the service's configured duration (GHL derives it if omitted).
    const durationMin = config.services.find((s) => s.name === serviceName)?.durationMin;
    const endTime = durationMin
      ? new Date(Date.parse(canonicalStart) + durationMin * 60_000).toISOString()
      : undefined;

    try {
      await ghl.rescheduleAppointment({
        appointmentId: appt.ghlAppointmentId,
        calendarId,
        startTime: canonicalStart,
        ...(endTime ? { endTime } : {}),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[rescheduleAppointment] GHL call failed:', msg);
      await logBotEvent(tenant.clientId, turn.ghlConversationId, 'booking_failed', {
        stage: 'reschedule',
        ghlAppointmentId: appt.ghlAppointmentId,
        serviceName,
        startTime: canonicalStart,
        error: msg,
      });
      return { rescheduled: false, message: 'No se pudo reagendar la cita en este momento. Intenta de nuevo o contacta al equipo.' };
    }

    // Record to our stats/proof layer — fire-and-forget.
    logAppointment({
      p_client_id: tenant.clientId,
      p_ghl_contact_id: turn.ghlContactId,
      p_action: 'rescheduled',
      // The resolved instant, never the model's string — our store must agree with GHL.
      p_appointment_datetime: canonicalStart,
      p_service_type: serviceName,
      p_source: 'front-desk',
      p_ghl_appointment_id: appt.ghlAppointmentId,
    }).catch((e: unknown) => console.error('[rescheduleAppointment] logAppointment failed:', e));

    // Hand back a tenant-tz label so the agent confirms the real time instead of
    // re-rendering an ISO string it might mis-state.
    const label = slotLabel(canonicalStart, frameTz, config.timezone);
    return {
      rescheduled: true,
      message: `Cita reagendada: ${label}. Confírmasela al lead usando EXACTAMENTE ese texto.`,
    };
  },
});
