/**
 * flagNoPromos (0073) — the lead said no to promotions but is still talking.
 *
 * Not an opt-out: `updateConversationStatus(opted_out)` mutes the bot and already writes
 * `no-promos` alongside `bot-opted-out`. This is the softer case — "no me manden promos
 * pero sí quiero agendar" — so the conversation stays `active` and the bot keeps answering;
 * only the `no-promos` tag goes on the contact. The tag webhook mirrors it into
 * `conversations.no_promos`, which the follow-up runner honours (a nudge is an offer) and
 * the client's GHL campaigns key on. Removing it is a person's call, never the bot's.
 */

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { logBotEvent } from '../../../db/queries.js';
import { GhlClient } from '../../../ghl/client.js';
import { NO_PROMOS_TAG } from '../../../ghl/tags.js';
import { resolveAgentContext } from './agent-context.js';

export const flagNoPromosTool = createTool({
  id: 'flagNoPromos',
  description:
    'Llámala cuando el lead diga que NO quiere promociones, ofertas o publicidad pero SIGUE conversando ' +
    '(quiere agendar, tiene dudas). No cierra la conversación ni te deja mudo: sólo marca al contacto para ' +
    'que no reciba promociones. Si lo que pide es que no le escriban MÁS, eso es updateConversationStatus(opted_out).',
  inputSchema: z.object({}),
  outputSchema: z.object({ ok: z.boolean() }),
  execute: async (_input, ctx) => {
    const { tenant, turn } = resolveAgentContext(ctx);

    // Demo roleplay never tags the real contact — same guard as every side-effect tool.
    if (turn.activeRole === 'demo') {
      console.log(`[flagNoPromos] demo no-op conv=${turn.ghlConversationId}`);
      return { ok: true };
    }

    try {
      await new GhlClient(tenant.tenantId).addContactTags(turn.ghlContactId, [NO_PROMOS_TAG]);
    } catch (e) {
      console.error('[flagNoPromos] tag write failed:', e instanceof Error ? e.message : String(e));
    }
    await logBotEvent(tenant.clientId, turn.ghlConversationId, 'no_promos_on', { source: 'agent' });
    return { ok: true };
  },
});
