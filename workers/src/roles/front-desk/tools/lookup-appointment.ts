/**
 * lookupAppointment — tell the lead when their appointment is.
 *
 * Resolves the contact's active appointment from our store, then reads its LIVE
 * status/time from GHL (falling back to our recorded datetime if the GHL read
 * fails). Use it when the lead asks about their existing appointment ("¿a qué hora
 * era mi cita?") — never invent a time.
 */

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { GhlClient } from '../../../ghl/client.js';
import { getActiveDemoSession, getBookingHold } from '../../../db/queries.js';
import { resolveAgentContext } from './agent-context.js';
import { describeHoldForModel } from './booking-hold.js';
import { resolveActiveAppointment } from './resolve-appointment.js';
import { slotLabel } from './slot-label.js';

export const lookupAppointmentTool = createTool({
  id: 'lookupAppointment',
  description:
    'Consulta la cita activa del contacto en el sistema (día y hora). Úsala cuando el lead pregunte ' +
    'por su cita o no recuerde cuándo es. No inventes horarios: si no hay cita activa, lo indica.',
  inputSchema: z.object({}),
  outputSchema: z.object({
    found: z.boolean(),
    startTime: z.string().optional(),
    label: z.string().optional(),
    service: z.string().optional(),
    /** Paid confirmation (0062): the hold's state, when the tenant charges for it. */
    paymentStatus: z.string().optional(),
    paymentUrl: z.string().optional(),
    message: z.string(),
  }),
  execute: async (_input, ctx) => {
    const { tenant, turn, config, frameTz } = resolveAgentContext(ctx);

    // Demo mode: answer from the session's simulated booking — never from the
    // real store/GHL (the demo must not see the lead's real appointments).
    if (turn.activeRole === 'demo') {
      const session = await getActiveDemoSession(turn.ghlConversationId).catch(() => null);
      const b = session?.simulatedBooking;
      if (!b) {
        return { found: false, message: 'No encuentro una cita activa a tu nombre.' };
      }
      return {
        found: true,
        startTime: b.startTime,
        label: b.label,
        service: b.serviceName,
        message: `La cita activa es: ${b.label} (${b.serviceName}). Preséntala usando ese texto exacto.`,
      };
    }

    const ghl = new GhlClient(tenant.tenantId);
    const appt = await resolveActiveAppointment(ghl, tenant.clientId, turn.ghlContactId, Date.now());
    if (!appt) {
      return { found: false, message: 'No encuentro una cita activa a tu nombre.' };
    }

    let startTime = appt.startTime ?? undefined;
    // Store-sourced: read GHL live in case it was moved/cancelled there since we booked it.
    // GHL-sourced already came from GHL live, so trust it as-is (no redundant read).
    if (appt.source === 'store') {
      try {
        const live = await ghl.getAppointment(appt.ghlAppointmentId);
        if (live.status && live.status.toLowerCase() === 'cancelled') {
          return { found: false, message: 'Tu cita aparece como cancelada en el sistema; no tienes una cita activa.' };
        }
        if (live.startTime) startTime = live.startTime;
      } catch (e) {
        console.error('[lookupAppointment] GHL read failed, using stored datetime:', e instanceof Error ? e.message : String(e));
      }
    }

    if (!startTime) {
      return { found: false, message: 'Tienes una cita registrada, pero no pude leer la fecha/hora. Contacta al equipo para confirmarla.' };
    }

    const label = slotLabel(startTime, frameTz, config.timezone);

    // Paid confirmation (0062): "¿ya quedó?" / "ya pagué" are answered from the hold, never
    // from the model's memory. An expired/cancelled hold means the slot was released.
    const hold = config.bookingPayment ? ((await getBookingHold(appt.ghlAppointmentId).catch(() => null)) ?? null) : null;
    if (hold && (hold.status === 'expired' || hold.status === 'cancelled')) {
      return {
        found: false,
        paymentStatus: hold.status,
        message: `La cita del ${label} ya no está activa: el apartado venció o se canceló y el lugar se liberó. Ofrécele agendar de nuevo; la liga anterior ya no sirve.`,
      };
    }
    return {
      found: true,
      startTime,
      label,
      service: appt.serviceType ?? undefined,
      ...(hold ? { paymentStatus: hold.status, paymentUrl: hold.checkoutUrl } : {}),
      message:
        `Tu cita es el ${label}. Preséntasela al lead usando EXACTAMENTE este texto; no recalcules la fecha.` +
        describeHoldForModel(hold, frameTz, config.timezone),
    };
  },
});
