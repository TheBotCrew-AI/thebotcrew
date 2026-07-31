/**
 * Fit-filter eval cases — The Bot Crew's own funnel.
 *
 * The rule under test: the platform sells to businesses that BOOK APPOINTMENTS
 * (to deliver a service, or a sales call). A business whose sale closes inside
 * the chat has nothing to schedule, so the bot must NOT start a demo for it —
 * it explains warmly and parks the conversation in `standby`.
 *
 * Two failure modes are worth a golden case, and they pull in opposite
 * directions — which is exactly why both are here:
 *   · under-filtering: burning a demo (and the closer pitch behind it) on a
 *     business the product can't serve;
 *   · over-filtering: killing a real lead on a hunch. A wrongly disqualified
 *     lead is far more expensive than a wasted demo, so an AMBIGUOUS signal
 *     must produce a QUESTION, never a disqualification.
 *
 * The tools are mocked inert: these cases assert on which tools the model
 * REACHES FOR, so nothing may touch the real DB or GHL. `demoSessionsEnabled`
 * is false as a second belt — startDemo short-circuits before any DB call.
 *
 * Live-only (needs an API key); `pnpm eval`, excluded from the CI gate.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../db/queries.js');
vi.mock('../../../ghl/client.js', () => ({
  GhlClient: vi.fn(() => ({ addContactTags: vi.fn().mockResolvedValue(undefined) })),
}));

import { buildFrontDeskAgent } from '../agent.js';
import { buildAgentRequestContext } from '../../../core/runtime-context.js';
import type { TenantContext, TurnContext } from '../../../core/types.js';
import { botCrewTenant } from './fixtures.js';
import { evalApiKey, evalModel, evalProvider } from './eval-model.js';

const turn: TurnContext = {
  ghlConversationId: 'conv_eval_fit',
  ghlContactId: 'contact_eval_fit',
  channel: 'whatsapp',
};

const rc = (tenant: TenantContext = botCrewTenant) =>
  buildAgentRequestContext({ tenant, turn, provider: evalProvider, model: evalModel, llmApiKey: evalApiKey });

type ToolCallChunkLike = { payload: { toolName: string; args?: unknown } };

/** Tool ids the model asked for this run, in call order (Mastra wraps them in a chunk). */
function toolIds(res: { toolCalls?: ToolCallChunkLike[] }): string[] {
  return (res.toolCalls ?? []).map((c) => c.payload.toolName);
}

/** The arguments the model passed to a given tool, if it called it. */
function toolArgs(res: { toolCalls?: ToolCallChunkLike[] }, toolName: string): Record<string, unknown> | undefined {
  const call = (res.toolCalls ?? []).find((c) => c.payload.toolName === toolName);
  return call?.payload.args as Record<string, unknown> | undefined;
}

beforeEach(() => vi.clearAllMocks());

describe.skipIf(!evalApiKey)('fit filter — a chat-only business is ruled out, warmly', () => {
  it('does not start a demo for a business whose sale closes in the chat', async () => {
    const agent = buildFrontDeskAgent();
    const res = await agent.generate(
      [
        { role: 'assistant', content: 'Hola 👋 ¿con quién tengo el gusto?' },
        { role: 'user', content: 'Soy Ana, quiero mi demo' },
        { role: 'assistant', content: 'Con gusto, Ana. ¿A qué se dedica tu negocio?' },
        {
          role: 'user',
          content:
            'Vendo ropa por Instagram. La gente me escribe, les paso el catálogo, me pagan por transferencia y se los mando por paquetería. No hay citas ni nada de eso.',
        },
      ],
      { requestContext: rc() },
    );

    // The crux: no demo for a business with nothing to schedule.
    expect(toolIds(res)).not.toContain('startDemo');
    // And it must be said, not silently dropped: an explanation the lead can act on.
    expect(res.text.toLowerCase()).toMatch(/cita|agenda|consulta|asesor/);
  });

  it('parks the conversation in standby instead of pitching the 20-min session', async () => {
    const agent = buildFrontDeskAgent();
    const res = await agent.generate(
      [
        { role: 'assistant', content: '¿A qué se dedica tu negocio?' },
        { role: 'user', content: 'Tengo una tienda en línea de suplementos, todo se vende por mensaje y lo envío por paquetería.' },
        { role: 'assistant', content: 'Entiendo. ¿Tus clientes agendan una cita o llamada contigo, o la compra se cierra ahí mismo por mensaje?' },
        { role: 'user', content: 'Se cierra ahí mismo, nunca agendo nada.' },
      ],
      { requestContext: rc() },
    );

    expect(toolIds(res)).not.toContain('startDemo');
    // It closes the loop rather than leaving a dangling lead the follow-up cron will chase.
    expect(toolIds(res)).toContain('updateConversationStatus');
    // …with the reason attached, or the disqualification is invisible in bot_events (0042).
    const args = toolArgs(res, 'updateConversationStatus');
    expect(args?.status).toBe('standby');
    expect(String(args?.reason ?? '')).toMatch(/cita|agenda/i);
    // It must not keep selling: no availability lookup, no 20-min session offer.
    expect(toolIds(res)).not.toContain('getAvailability');
    expect(res.text.toLowerCase()).not.toMatch(/20 ?min|veinte minutos/);
  });
});

describe.skipIf(!evalApiKey)('fit filter — the expensive mistake is over-filtering', () => {
  it('asks the qualifying question instead of ruling out an ambiguous business', async () => {
    const agent = buildFrontDeskAgent();
    const res = await agent.generate(
      [
        { role: 'assistant', content: '¿A qué se dedica tu negocio?' },
        // Ambiguous on purpose: "vendo" reads chat-only, but a nutriólogo consults by appointment.
        { role: 'user', content: 'Vendo planes de nutrición, la gente me escribe por Instagram y ahí les vendo.' },
      ],
      { requestContext: rc() },
    );

    // A hunch is not grounds to disqualify: no standby, no goodbye — a question.
    expect(toolIds(res)).not.toContain('updateConversationStatus');
    expect(res.text).toContain('?');
  });

  it('still takes a small appointment-based business — size and volume never disqualify', async () => {
    const agent = buildFrontDeskAgent();
    const res = await agent.generate(
      [
        { role: 'assistant', content: '¿A qué se dedica tu negocio?' },
        { role: 'user', content: 'Doy masajes en casa, soy yo sola y me llegan como 5 mensajes por semana. Igual me sirve?' },
      ],
      { requestContext: rc() },
    );

    expect(toolIds(res)).not.toContain('updateConversationStatus');
    expect(res.text.toLowerCase()).not.toMatch(/no es para ti|no te serv|no encajas|no aplica para tu/);
  });
});
