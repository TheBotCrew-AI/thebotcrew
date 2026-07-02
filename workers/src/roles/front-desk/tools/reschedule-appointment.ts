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
import { loadLatestAppointment, logAppointment, logBotEvent } from '../../../db/queries.js';
import { resolveAgentContext } from './agent-context.js';
import { resolveBookingWindow } from './booking-window.js';

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
    const { tenant, turn, config } = resolveAgentContext(ctx);

    const appt = await loadLatestAppointment(tenant.clientId, turn.ghlContactId);
    if (!appt || appt.action === 'cancelled') {
      return { rescheduled: false, message: 'No encuentro una cita activa para reagendar.' };
    }

    const serviceName = appt.serviceType;
    const calendarId = serviceName ? config.calendars[serviceName] : undefined;
    if (!serviceName || !calendarId) {
      return { rescheduled: false, message: 'No pude identificar el calendario de la cita para reagendarla.' };
    }

    // Validate the requested time is a REAL free slot (within the booking horizon).
    const horizon = config.bookingHorizonDays ?? null;
    const window = resolveBookingWindow(Date.now(), startTime, undefined, horizon);
    if (window.outOfHorizon) {
      return {
        rescheduled: false,
        message: `Ese horario queda fuera de la ventana de agendado (próximos ${horizon} días). Ofrece un horario dentro de ella.`,
      };
    }

    const targetMs = new Date(startTime).getTime();
    const ghl = new GhlClient(tenant.tenantId);
    let isFree = false;
    try {
      const slots = await ghl.getAvailability(
        calendarId,
        new Date(window.fromMs).toISOString(),
        new Date(window.toMs).toISOString(),
      );
      isFree = slots.some((s) => new Date(s.start).getTime() === targetMs);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[rescheduleAppointment] availability check failed:', msg);
      return { rescheduled: false, message: 'No pude verificar la disponibilidad en este momento. Intenta de nuevo.' };
    }
    if (!isFree) {
      return {
        rescheduled: false,
        message: 'Ese horario no está disponible. Ofrece uno de los horarios que devolvió getAvailability.',
      };
    }

    // Optional endTime from the service's configured duration (GHL derives it if omitted).
    const durationMin = config.services.find((s) => s.name === serviceName)?.durationMin;
    const endTime = durationMin ? new Date(targetMs + durationMin * 60_000).toISOString() : undefined;

    try {
      await ghl.rescheduleAppointment({
        appointmentId: appt.ghlAppointmentId,
        calendarId,
        startTime,
        ...(endTime ? { endTime } : {}),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[rescheduleAppointment] GHL call failed:', msg);
      await logBotEvent(tenant.clientId, turn.ghlConversationId, 'booking_failed', {
        stage: 'reschedule',
        ghlAppointmentId: appt.ghlAppointmentId,
        serviceName,
        startTime,
        error: msg,
      });
      return { rescheduled: false, message: 'No se pudo reagendar la cita en este momento. Intenta de nuevo o contacta al equipo.' };
    }

    // Record to our stats/proof layer — fire-and-forget.
    logAppointment({
      p_client_id: tenant.clientId,
      p_ghl_contact_id: turn.ghlContactId,
      p_action: 'rescheduled',
      p_appointment_datetime: startTime,
      p_service_type: serviceName,
      p_source: 'front-desk',
      p_ghl_appointment_id: appt.ghlAppointmentId,
    }).catch((e: unknown) => console.error('[rescheduleAppointment] logAppointment failed:', e));

    return { rescheduled: true, message: `Cita reagendada a ${startTime}.` };
  },
});
