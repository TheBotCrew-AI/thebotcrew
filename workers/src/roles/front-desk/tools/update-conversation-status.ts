/**
 * updateConversationStatus — mark the conversation as completed, opted_out,
 * standby, or handed_off. Atomically cancels any pending follow-ups.
 *
 * Front-desk only. Call this as the LAST action in a turn when the conversation
 * has reached a terminal or paused state — never in the middle of a flow.
 *
 * An optional `reason` records WHY. The RPC already logs `status_changed
 * {from,to}`, but a lead ruled out on purpose and a conversation that merely
 * ran its course both land in `standby` and look identical there — so a stated
 * reason is additionally logged as `lead_disqualified` (0042). It stays free
 * text: the reason worth catching is the one we didn't predict.
 */

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { logBotEvent, updateConversationStatus } from '../../../db/queries.js';
import { GhlClient } from '../../../ghl/client.js';
import { STATUS_TAGS } from '../../../ghl/tags.js';
import { resolveAgentContext } from './agent-context.js';

/** Cap on the model-written reason: an event payload, not a place to narrate. */
const REASON_MAX_LENGTH = 200;

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
    reason: z
      .string()
      .trim()
      .min(1)
      .max(REASON_MAX_LENGTH)
      .optional()
      .describe(
        'Motivo breve, en tus palabras, de por qué descartas o pausas a este lead. ' +
          'Obligatorio cuando lo descalificas porque su negocio no encaja (ej. "no agenda citas"). ' +
          'Déjalo vacío cuando la conversación simplemente terminó su curso normal.',
      ),
  }),
  outputSchema: z.object({ ok: z.boolean() }),
  execute: async ({ status, reason }, ctx) => {
    const { tenant, turn } = resolveAgentContext(ctx);

    // Demo roleplay never mutates real state: a fake customer's "ya no me interesa"
    // must not opt the REAL lead out (or tag their real GHL contact). Pretend success
    // so the model closes the exchange naturally; the prompt also forbids the call.
    if (turn.activeRole === 'demo') {
      console.log(`[updateConversationStatus] demo no-op conv=${turn.ghlConversationId} status=${status}`);
      return { ok: true };
    }

    await updateConversationStatus(turn.ghlConversationId, status);

    // Why, not just what. Awaited (not fire-and-forget) for the same reason as every
    // other event write: the Worker can be killed the moment the response is sent.
    // logBotEvent swallows its own errors, so this can never fail the status change.
    if (reason) {
      await logBotEvent(tenant.clientId, turn.ghlConversationId, 'lead_disqualified', { status, reason });
    }

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
