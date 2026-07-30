/**
 * startDemo — turn the intake facts the agent collected into a live, budgeted
 * demo session (the lead-magnet funnel): builds the persona from a template,
 * creates the demo_sessions row and flips the conversation into the demo
 * persona ATOMICALLY (app_create_demo_session), all in one call.
 *
 * The flip applies from the NEXT turn — the current turn still speaks as the
 * normal persona, which is exactly right: it announces the demo ("escríbeme
 * como si fueras un cliente…") and the lead's next message is answered in
 * character. Gated per tenant by tenant_config.demo_sessions_enabled; the
 * manual keyword demo (0028) is unaffected and never creates sessions.
 */

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { createDemoSession, logBotEvent } from '../../../db/queries.js';
import { buildDemoPersona, PERSONA_VERSION } from '../demo-persona.js';
import { resolveAgentContext } from './agent-context.js';

/** Bot message PARTS (what the lead sees as messages) before the closer takes over. */
export const DEMO_MESSAGE_BUDGET = 15;
/** Wall-clock cap: an abandoned demo ends (as 'expired') when the lead next writes. */
export const DEMO_EXPIRES_MINUTES = 48 * 60;

export const startDemoTool = createTool({
  id: 'startDemo',
  description:
    'Activa una demo en vivo del asistente PARA EL NEGOCIO DEL LEAD, con los datos que el lead te dio en esta ' +
    'conversación. Llámala SOLO cuando ya tengas al menos: nombre del negocio, giro, y sus servicios principales. ' +
    'Tras llamarla, avísale al lead que la demo está lista y que escriba como si fuera un cliente de su negocio.',
  inputSchema: z.object({
    businessName: z.string().min(1).describe('Nombre del negocio del lead, tal como te lo dio'),
    businessType: z.string().min(1).describe('Giro del negocio (ej. "clínica dental", "estética")'),
    services: z
      .array(z.string().min(1))
      .min(1)
      .max(5)
      .describe('Servicios principales que mencionó (máx. 5), con precio si lo dio'),
    tone: z.string().optional().describe('Tono pedido por el lead para su asistente, si lo mencionó'),
    hoursDescription: z.string().optional().describe('Horario del negocio en texto libre, si lo mencionó'),
    notes: z.string().optional().describe('Cualquier otro dato relevante que el lead haya dado sobre su negocio'),
  }),
  outputSchema: z.object({ ok: z.boolean(), message: z.string() }),
  execute: async (input, ctx) => {
    const { tenant, turn } = resolveAgentContext(ctx);

    if (!tenant.demoSessionsEnabled) {
      return { ok: false, message: 'La función de demo no está disponible en este momento.' };
    }
    if (turn.activeRole === 'demo') {
      // The demo persona must not spawn demos from inside the roleplay.
      return { ok: false, message: 'Ya hay una demo activa en esta conversación.' };
    }

    const persona = buildDemoPersona(input);

    let sessionId: string;
    try {
      sessionId = await createDemoSession({
        ghlConversationId: turn.ghlConversationId,
        leadData: persona.leadData,
        promptOverrides: persona.overrides,
        messageBudget: DEMO_MESSAGE_BUDGET,
        expiresMinutes: DEMO_EXPIRES_MINUTES,
        personaVersion: PERSONA_VERSION,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[startDemo] createDemoSession failed:', msg);
      await logBotEvent(tenant.clientId, turn.ghlConversationId, 'db_error', {
        stage: 'create_demo_session',
        error: msg,
      });
      return { ok: false, message: 'No se pudo activar la demo en este momento. Discúlpate y ofrece intentarlo de nuevo.' };
    }

    await logBotEvent(tenant.clientId, turn.ghlConversationId, 'demo_session_started', {
      sessionId,
      personaVersion: PERSONA_VERSION,
      businessName: persona.leadData.businessName,
      businessType: persona.leadData.businessType,
    });

    return {
      ok: true,
      message:
        'Demo activada. Dile al lead que su demo está lista y que escriba su siguiente mensaje como si fuera ' +
        'un cliente de su negocio — a partir de ese mensaje responderá el asistente demo.',
    };
  },
});
