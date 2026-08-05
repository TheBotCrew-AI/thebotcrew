/**
 * flagPendingInfo — the lead asked something the config doesn't answer.
 *
 * The behavior this replaces: the bot hedged ("¿quieres que lo pregunte?") or bounced
 * the question to the valoración, and the gap died in the thread. Nobody learned the
 * config was missing a fact, so the next lead hit the same wall.
 *
 * Now the bot ASSERTS ("déjame lo confirmo con el equipo y te aviso") and calls this.
 * Three effects, and the split is the whole design:
 *  - `awaiting_human` on the conversation — same status flagAwaitingHuman uses, for the
 *    same reason (0035): we owe HER an answer, so automated nudges are backwards. The
 *    bot is NOT muted; she can keep asking about anything else and get answered.
 *  - a tag on the GHL contact from `tenant_config.pending_info_tag` — a SECOND tag, not
 *    `awaiting_human_tag`. That one is the client's booking queue; this one is ours (the
 *    prompt has a hole). One tag for both means the receptionist answers, clears it, and
 *    the config gap is never fixed.
 *  - a `pending_info` bot_event carrying the lead's question VERBATIM. The tag gets
 *    removed when someone handles it; the event is what survives, which makes
 *    `bot_events` the ranked list of what each tenant's config still lacks.
 *
 * Removing either tag in GHL flips the conversation back to `active` and re-arms the
 * follow-ups (tag-handler.ts treats both as one signal).
 *
 * NOT for: something `lookupFaq` answers (the model must try that first — see the FAQ
 * section of the prompt), a real handoff (anger, a clinical question, "quiero hablar con
 * alguien" → handed_off), or a booking request (→ flagAwaitingHuman).
 */

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { logBotEvent, updateConversationStatus } from '../../../db/queries.js';
import { GhlClient } from '../../../ghl/client.js';
import { resolveAgentContext } from './agent-context.js';

export const flagPendingInfoTool = createTool({
  id: 'flagPendingInfo',
  description:
    'Regístralo cuando el lead pregunta un dato CONCRETO de este negocio que NO está en tu información ' +
    '(un precio que no tienes, formas de pago, una política, algo que el negocio nunca nos dio) y ya ' +
    'verificaste que no está en lookupFaq. Llámala en el MISMO turno en que le dices que lo confirmas con ' +
    'el equipo. No pide permiso ni deja muda a la conversación: puedes seguir atendiéndola con normalidad.',
  inputSchema: z.object({
    question: z
      .string()
      .describe('La duda del lead TAL CUAL la preguntó, en sus palabras. Es lo que una persona va a revisar.'),
    topic: z
      .string()
      .optional()
      .describe('Tema en 2-3 palabras para agrupar (p. ej. "formas de pago", "precio piernas completas").'),
  }),
  outputSchema: z.object({ ok: z.boolean() }),
  execute: async ({ question, topic }, ctx) => {
    const { tenant, turn } = resolveAgentContext(ctx);

    // Demo roleplay: the "business" is the lead's own, invented from three facts a
    // minute ago, so EVERYTHING is a gap. Flagging here would tag the real contact and
    // stop the real follow-ups over a fictional question. Same guard as every other
    // side-effect tool; the prompt forbids it too.
    if (turn.activeRole === 'demo') {
      console.log(`[flagPendingInfo] demo no-op conv=${turn.ghlConversationId}`);
      return { ok: true };
    }

    await updateConversationStatus(turn.ghlConversationId, 'awaiting_human');

    const tag = tenant.pendingInfoTag?.trim();
    if (tag) {
      try {
        await new GhlClient(tenant.tenantId).addContactTags(turn.ghlContactId, [tag]);
      } catch (e) {
        // Best-effort, like every other tag write: never fail the turn over the mirror.
        console.error('[flagPendingInfo] tag write failed:', e instanceof Error ? e.message : String(e));
      }
    }

    await logBotEvent(tenant.clientId, turn.ghlConversationId, 'pending_info', {
      tag: tag ?? null,
      question: question.slice(0, 500),
      topic: topic?.slice(0, 100) ?? null,
    });

    return { ok: true };
  },
});
