/**
 * updateContactName — correct the contact's name in GHL when the lead gives a real
 * name that differs from what's stored (page-form leads often arrive named after their
 * business). Prompt-driven: only tenants whose flow asks the agent to confirm the name
 * will ever call this. Best-effort — a failure is logged, never surfaced to the lead.
 */

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { GhlClient } from '../../../ghl/client.js';
import { logBotEvent } from '../../../db/queries.js';
import { resolveAgentContext } from './agent-context.js';

export const updateContactNameTool = createTool({
  id: 'updateContactName',
  description:
    'Corrige el nombre del contacto en el CRM cuando el lead te da su nombre real y NO coincide con el ' +
    'que está registrado (caso típico: el formulario guardó el nombre del negocio en vez del de la persona). ' +
    'Llámalo SOLO cuando el lead te haya dado un nombre distinto al registrado. No lo llames si el nombre ' +
    'registrado ya es correcto ni si el lead no te dio un nombre.',
  inputSchema: z.object({
    name: z
      .string()
      .min(1)
      .describe('El nombre de la persona tal como te lo dio el lead (ej. "Carlos" o "Carlos Pérez").'),
  }),
  outputSchema: z.object({ ok: z.boolean() }),
  execute: async ({ name }, ctx) => {
    const { tenant, turn } = resolveAgentContext(ctx);
    const trimmed = name.trim().replace(/\s+/g, ' ');
    if (!trimmed) return { ok: false };
    const [firstName, ...rest] = trimmed.split(' ');
    const lastName = rest.join(' ');
    try {
      await new GhlClient(tenant.tenantId).updateContactName(turn.ghlContactId, { firstName, lastName });
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[updateContactName] failed (non-blocking):', msg);
      await logBotEvent(tenant.clientId, turn.ghlConversationId, 'db_error', {
        stage: 'update_contact_name',
        error: msg,
      });
      return { ok: false };
    }
  },
});
