/**
 * guardarWhatsapp — write the lead's WhatsApp/phone number onto the GHL contact so
 * appointment confirmations and reminders can reach them. Needed especially for
 * FB/IG leads (those channels carry no phone). The agent confirms or captures the
 * number before booking; GHL then sends confirmation/reminder templates to it.
 */

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { GhlClient } from '../../../ghl/client.js';
import { logBotEvent } from '../../../db/queries.js';
import { resolveAgentContext } from './agent-context.js';

export const saveWhatsappNumberTool = createTool({
  id: 'guardarWhatsapp',
  description:
    'Guarda el número de WhatsApp del lead en su contacto de GHL (para confirmación y recordatorios de la cita). ' +
    'Úsalo cuando el lead te dé un número nuevo o corrija el que ya teníamos. Captúralo con código de país.',
  inputSchema: z.object({
    phone: z.string().describe('Número de WhatsApp del lead, con código de país (ej. +526641234567)'),
  }),
  outputSchema: z.object({ saved: z.boolean(), phone: z.string().optional(), message: z.string() }),
  execute: async ({ phone }, ctx) => {
    const { tenant, turn } = resolveAgentContext(ctx);
    // Light cleanup: keep a leading + and digits only.
    const cleaned = phone.replace(/[^\d+]/g, '');
    if (cleaned.replace(/\D/g, '').length < 8) {
      return { saved: false, message: 'El número no parece válido; pídelo de nuevo con código de país.' };
    }
    try {
      await new GhlClient(tenant.tenantId).updateContactPhone(turn.ghlContactId, cleaned);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[guardarWhatsapp] GHL update failed:', msg);
      await logBotEvent(tenant.clientId, turn.ghlConversationId, 'db_error', {
        stage: 'update_contact_phone',
        error: msg,
      });
      return { saved: false, message: 'No pude guardar el número ahora; inténtalo de nuevo en un momento.' };
    }
    return { saved: true, phone: cleaned, message: `Número guardado: ${cleaned}.` };
  },
});
