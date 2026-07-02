/**
 * cancelAppointment — soft-cancel the contact's active appointment in GHL, record
 * it, and reopen the conversation so the bot can offer to rebook.
 *
 * The agent must confirm the intent explicitly with the lead BEFORE calling this
 * (see the prompt rules) — never cancel on an ambiguous message.
 */

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { GhlClient } from '../../../ghl/client.js';
import { loadLatestAppointment, logAppointment, logBotEvent, reactivateConversation } from '../../../db/queries.js';
import { resolveAgentContext } from './agent-context.js';

export const cancelAppointmentTool = createTool({
  id: 'cancelAppointment',
  description:
    'Cancela la cita activa del contacto en el calendario. Úsala SOLO después de que el lead confirmó ' +
    'explícitamente que quiere cancelar. Si no hay una cita activa, lo indica sin inventar.',
  inputSchema: z.object({}),
  outputSchema: z.object({
    cancelled: z.boolean(),
    message: z.string(),
  }),
  execute: async (_input, ctx) => {
    const { tenant, turn } = resolveAgentContext(ctx);

    const appt = await loadLatestAppointment(tenant.clientId, turn.ghlContactId);
    if (!appt || appt.action === 'cancelled') {
      return { cancelled: false, message: 'No encuentro una cita activa para cancelar.' };
    }

    const ghl = new GhlClient(tenant.tenantId);
    try {
      await ghl.cancelAppointment(appt.ghlAppointmentId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[cancelAppointment] GHL call failed:', msg);
      await logBotEvent(tenant.clientId, turn.ghlConversationId, 'booking_failed', {
        stage: 'cancel',
        ghlAppointmentId: appt.ghlAppointmentId,
        error: msg,
      });
      return { cancelled: false, message: 'No se pudo cancelar la cita en este momento. Intenta de nuevo o contacta al equipo.' };
    }

    // Record to our stats/proof layer — fire-and-forget.
    logAppointment({
      p_client_id: tenant.clientId,
      p_ghl_contact_id: turn.ghlContactId,
      p_action: 'cancelled',
      p_appointment_datetime: appt.appointmentDatetime,
      p_service_type: appt.serviceType,
      p_source: 'front-desk',
      p_ghl_appointment_id: appt.ghlAppointmentId,
    }).catch((e: unknown) => console.error('[cancelAppointment] logAppointment failed:', e));

    // Reopen the conversation (booking had set it 'completed') so the bot can offer to rebook.
    reactivateConversation(turn.ghlConversationId).catch((e: unknown) =>
      console.error('[cancelAppointment] reactivateConversation failed:', e),
    );

    return { cancelled: true, message: 'Cita cancelada.' };
  },
});
