/**
 * updateConversationStatus — mark the conversation as completed, opted_out,
 * standby, or handed_off. Atomically cancels any pending follow-ups.
 *
 * Front-desk only. Call this as the LAST action in a turn when the conversation
 * has reached a terminal or paused state — never in the middle of a flow.
 */

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { updateConversationStatus } from '../../../db/queries.js';
import { GhlClient } from '../../../ghl/client.js';
import { STATUS_TAGS } from '../../../ghl/tags.js';
import { resolveAgentContext } from './agent-context.js';

export const updateConversationStatusTool = createTool({
  id: 'updateConversationStatus',
  description:
    'Actualiza el estado de la conversación. Llámalo solo cuando la conversación llegue a un estado terminal o de pausa. ' +
    'completed = lead agendó o ya no necesita ayuda. ' +
    'opted_out = lead pidió no recibir más mensajes. ' +
    'standby = el bot terminó su flujo pero la conversación puede reactivarse. ' +
    'handed_off = traspasado a un agente humano.',
  inputSchema: z.object({
    status: z
      .enum(['completed', 'opted_out', 'standby', 'handed_off'])
      .describe('Estado destino de la conversación'),
  }),
  outputSchema: z.object({ ok: z.boolean() }),
  execute: async ({ status }, ctx) => {
    const { tenant, turn } = resolveAgentContext(ctx);
    await updateConversationStatus(turn.ghlConversationId, status);

    // Mirror the state onto the GHL contact as a tag (transparency / sync).
    // For handed_off this writes `bot-off`, which keeps the bot suppressed AND
    // is visible to the human in GHL. Best-effort — never fail the tool on it.
    const tag = STATUS_TAGS[status as keyof typeof STATUS_TAGS];
    if (tag) {
      try {
        await new GhlClient(tenant.tenantId).addContactTags(turn.ghlContactId, [tag]);
      } catch (e) {
        console.error('[updateConversationStatus] tag sync failed:', e instanceof Error ? e.message : String(e));
      }
    }
    return { ok: true };
  },
});
