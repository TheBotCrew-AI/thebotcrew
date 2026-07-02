/**
 * bookAppointment — create the appointment in GHL, then record it in our DB.
 * The agent must only confirm a booking AFTER this tool succeeds.
 */

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { GhlClient } from '../../../ghl/client.js';
import { logAppointment, logBotEvent, logEvent } from '../../../db/queries.js';
import { resolveAgentContext } from './agent-context.js';

export const bookAppointmentTool = createTool({
  id: 'bookAppointment',
  description:
    'Crea una cita real en el calendario para un servicio y horario. Úsala solo tras confirmar ' +
    'la disponibilidad con getAvailability. No confirmes la cita al cliente hasta que esta herramienta tenga éxito.',
  inputSchema: z.object({
    serviceName: z.string().describe('Nombre exacto del servicio'),
    startTime: z.string().describe('Fecha/hora de inicio en ISO 8601'),
    whatsappPhone: z
      .string()
      .optional()
      .describe(
        'Número de WhatsApp con código de país (ej. +526641234567) que el lead te DIO o CONFIRMÓ ' +
          'explícitamente en la conversación para recibir confirmación y recordatorios. ' +
          'Inclúyelo SOLO si el lead te lo dio/confirmó ahora; NUNCA lo extraigas del texto de un ' +
          'formulario ni lo inventes. Omítelo si el contacto ya tiene el número correcto.',
      ),
  }),
  outputSchema: z.object({
    booked: z.boolean(),
    ghlAppointmentId: z.string().optional(),
    message: z.string(),
  }),
  execute: async ({ serviceName, startTime, whatsappPhone }, ctx) => {
    const { config, tenant, turn } = resolveAgentContext(ctx);
    const calendarId = config.calendars[serviceName];
    if (!calendarId) {
      return { booked: false, message: `No tengo un calendario para "${serviceName}".` };
    }

    const ghl = new GhlClient(tenant.tenantId);

    // Save the reminder number ONLY as part of booking (never earlier), and ONLY when the
    // contact has NO phone yet (the FB/IG case). We NEVER overwrite an existing phone:
    // changing a WhatsApp contact's number breaks the 24h messaging window — GHL/Meta treat it
    // as a new number with no lead interaction, so the bot can no longer reply (templates only).
    // A failure here is logged but does NOT block the booking.
    if (whatsappPhone) {
      const cleaned = whatsappPhone.replace(/[^\d+]/g, '');
      if (cleaned.replace(/\D/g, '').length >= 8) {
        try {
          const current = await ghl.getContactPhone(turn.ghlContactId);
          if (!current) {
            await ghl.updateContactPhone(turn.ghlContactId, cleaned);
          }
          // else: already has a number — leave it untouched (see comment above).
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error('[bookAppointment] phone save failed (non-blocking):', msg);
          await logBotEvent(tenant.clientId, turn.ghlConversationId, 'db_error', {
            stage: 'update_contact_phone',
            error: msg,
          });
        }
      }
    }

    let ghlAppointmentId: string | undefined;
    try {
      ({ ghlAppointmentId } = await ghl.bookAppointment({
        calendarId,
        locationId: tenant.ghlLocationId,
        contactId: turn.ghlContactId,
        startTime,
        title: serviceName,
      }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[bookAppointment] GHL call failed:', msg);
      // Persist the GHL rejection (status + body live in msg) so a failed booking is
      // diagnosable from bot_events instead of only ephemeral Cloudflare logs.
      await logBotEvent(tenant.clientId, turn.ghlConversationId, 'booking_failed', {
        serviceName,
        calendarId,
        startTime,
        error: msg,
      });
      return { booked: false, message: 'No se pudo confirmar la cita en este momento. Intenta de nuevo o contacta al equipo.' };
    }

    // Record to our stats/proof layer — fire-and-forget, don't fail the tool on log errors.
    logAppointment({
      p_client_id: tenant.clientId,
      p_ghl_contact_id: turn.ghlContactId,
      p_action: 'booked',
      p_appointment_datetime: startTime,
      p_service_type: serviceName,
      p_source: 'front-desk',
      p_ghl_appointment_id: ghlAppointmentId ?? null,
    }).catch((e: unknown) => console.error('[bookAppointment] logAppointment failed:', e));
    logEvent({
      p_client_id: tenant.clientId,
      p_ghl_conversation_id: turn.ghlConversationId,
      p_event_type: 'lead_qualified',
      p_metadata: { service: serviceName, startTime },
    }).catch((e: unknown) => console.error('[bookAppointment] logEvent failed:', e));

    return {
      booked: true,
      ghlAppointmentId,
      message: `Cita agendada: ${serviceName} el ${startTime}.`,
    };
  },
});
