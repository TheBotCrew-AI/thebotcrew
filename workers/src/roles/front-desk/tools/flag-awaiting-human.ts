/**
 * flagAwaitingHuman — leave the lead's request ready for a person to pick up.
 *
 * For tenants that can't book through the bot (see promptOverrides.bookingEnabled):
 * the bot gathers the request, then marks it so the owner finds it in GHL.
 *
 * Two things happen, and the split matters:
 *  - A configurable TAG on the GHL contact (`tenant_config.awaiting_human_tag`) —
 *    the operational signal. It's a per-tenant string, not a shared constant, so a
 *    tenant can name its own smart list and this never collides with `bot-off`.
 *  - `standby` on the conversation — stops follow-ups, but deliberately does NOT
 *    mute the bot.
 *
 * That second point is the whole design. Using `handed_off` here (as this flow first
 * did) mutes the bot permanently AND is the one status `app_reactivate_conversation`
 * refuses to revive — so the bot would ask "¿mañana o tarde?" and then go deaf to the
 * answer. With `standby` the lead can keep asking about prices and still get answers,
 * while the person owns the scheduling. A human replying in GHL still pauses the bot
 * on its own (the 5-min sliding takeover), and `bot-off` is still there for silence.
 */

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { logBotEvent, updateConversationStatus } from '../../../db/queries.js';
import { GhlClient } from '../../../ghl/client.js';
import { resolveAgentContext } from './agent-context.js';

export const flagAwaitingHumanTool = createTool({
  id: 'flagAwaitingHuman',
  description:
    'Marca la conversación como "esperando atención de una persona del equipo" y deja la solicitud lista. ' +
    'Úsala cuando el lead pidió una cita y ya capturaste su preferencia: no agendas tú, la agenda una persona. ' +
    'Llámala SOLO en el turno en que le dices al lead que vas a revisar y confirmarle — nunca en un turno donde le haces una pregunta.',
  inputSchema: z.object({
    summary: z
      .string()
      .optional()
      .describe('Resumen corto de lo que pidió el lead (servicio + preferencia de horario), para el registro interno.'),
  }),
  outputSchema: z.object({ ok: z.boolean() }),
  execute: async ({ summary }, ctx) => {
    const { tenant, turn, config } = resolveAgentContext(ctx);

    // Stops follow-ups without muting the bot. A lead's next message flips this back to
    // 'active' (app_reactivate_conversation), which is exactly what we want: questions
    // still get answered while the person handles the scheduling.
    await updateConversationStatus(turn.ghlConversationId, 'standby');

    const tag = tenant.awaitingHumanTag?.trim();
    if (tag) {
      try {
        await new GhlClient(tenant.tenantId).addContactTags(turn.ghlContactId, [tag]);
      } catch (e) {
        // Best-effort, like every other tag write: never fail the turn over the mirror.
        console.error('[flagAwaitingHuman] tag write failed:', e instanceof Error ? e.message : String(e));
      }
    }

    await logBotEvent(tenant.clientId, turn.ghlConversationId, 'awaiting_human', {
      tag: tag ?? null,
      summary: summary?.slice(0, 300) ?? null,
      service: config.businessName,
    });

    return { ok: true };
  },
});
