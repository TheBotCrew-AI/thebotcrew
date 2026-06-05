/**
 * bookAppointment — create the appointment in GHL, then record it in our DB.
 * The agent must only confirm a booking AFTER this tool succeeds.
 */

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { GhlClient } from '../../../ghl/client.js';
import { logAppointment, logEvent } from '../../../db/queries.js';
import { resolveAgentContext } from './agent-context.js';

export const bookAppointmentTool = createTool({
  id: 'bookAppointment',
  description:
    'Crea una cita real en el calendario para un servicio y horario. Úsala solo tras confirmar ' +
    'la disponibilidad con getAvailability. No confirmes la cita al cliente hasta que esta herramienta tenga éxito.',
  inputSchema: z.object({
    serviceName: z.string().describe('Nombre exacto del servicio'),
    startTime: z.string().describe('Fecha/hora de inicio en ISO 8601'),
  }),
  outputSchema: z.object({
    booked: z.boolean(),
    ghlAppointmentId: z.string().optional(),
    message: z.string(),
  }),
  execute: async ({ serviceName, startTime }, ctx) => {
    const { config, tenant, turn } = resolveAgentContext(ctx);
    const calendarId = config.calendars[serviceName];
    if (!calendarId) {
      return { booked: false, message: `No tengo un calendario para "${serviceName}".` };
    }

    const ghl = new GhlClient();
    const { ghlAppointmentId } = await ghl.bookAppointment({
      calendarId,
      contactId: turn.ghlContactId,
      startTime,
      title: serviceName,
    });

    // Record to our stats/proof layer (existing RPCs).
    await logAppointment({
      p_client_id: tenant.clientId,
      p_ghl_contact_id: turn.ghlContactId,
      p_action: 'booked',
      p_appointment_datetime: startTime,
      p_service_type: serviceName,
      p_source: 'front-desk',
      p_ghl_appointment_id: ghlAppointmentId,
    });
    await logEvent({
      p_client_id: tenant.clientId,
      p_ghl_conversation_id: turn.ghlConversationId,
      p_event_type: 'lead_qualified',
      p_metadata: { service: serviceName, startTime },
    });

    return {
      booked: true,
      ghlAppointmentId,
      message: `Cita agendada: ${serviceName} el ${startTime}.`,
    };
  },
});
