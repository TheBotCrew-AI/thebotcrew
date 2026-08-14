/**
 * Golden cases for The Bot Crew's own funnel — the Club Fundador (2026-08-14).
 *
 * Two families of rule, both living in `houseRules` so a future campaign variant
 * can't take them down with the flow (business-logic §1.1):
 *
 *   · THE FIT FILTER. The Club automates the messages a business ALREADY gets, so
 *     the question is whether customers write to them today — not whether they book
 *     appointments, which is what the previous offer sold. The two failure modes
 *     pull in opposite directions, which is why both are here: ruling out a real
 *     lead is far more expensive than talking to a bad one, so an AMBIGUOUS signal
 *     must produce a QUESTION, never a disqualification.
 *
 *   · THE MONEY DISCLOSURE. The price has two parts — the founder fee AND the AI
 *     consumption on top — and the fee alone is the seductive half. A model that
 *     omits the second half breaks nothing that any metric can see: the lead joins,
 *     finds out a week later, and feels lied to. It is the same complaint that made
 *     the previous offer's first wording fail ("ok, ¿y el servicio?"), which is
 *     exactly why it is a golden case and not a code comment.
 *
 * The tools are mocked inert: these cases assert on which tools the model REACHES
 * FOR, so nothing may touch the real DB or GHL.
 *
 * What each case is worth (§6c: a case not shown FAILING without its rule proves
 * nothing). Measured on `gpt-5.6-luna`, 2026-08-14:
 *   · "discloses both halves" is a REPRODUCTION. Deleting the disclosure rule from
 *     the fixture — while LEAVING the AI-cost fact in `offering`, so the model still
 *     has it to say — made it fail 2 of 4 runs: the model quotes the fee and drops
 *     the second half. With the rule: 4 of 4 clean.
 *   · the rest are GUARDS. They pin behavior that already holds and would catch a
 *     regression; they were not shown failing, so they are not evidence that the
 *     wording they exercise is what produces the behavior.
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

describe.skipIf(!evalApiKey)('fit filter — the expensive mistake is ruling someone out', () => {
  // The regression this locks down is the MIGRATION itself: under the previous offer
  // this exact lead was a textbook disqualification ("la compra se cierra en el chat,
  // no hay nada que agendar"). Under the Club she is a candidate — she is drowning in
  // the very DMs the product answers. If the old rule ever creeps back into the tenant
  // row, this is the case that catches it.
  it('takes a shop that sells by DM — the old offer ruled that out, this one does not', async () => {
    const agent = buildFrontDeskAgent();
    const res = await agent.generate(
      [
        {
          role: 'user',
          content:
            'Vengo de Skool. Vendo ropa por Instagram, la gente me escribe, les paso el catálogo y me pagan por transferencia. No agendo citas ni nada. ¿Esto me sirve?',
        },
      ],
      { requestContext: rc() },
    );

    expect(toolIds(res)).not.toContain('updateConversationStatus');
    expect(res.text.toLowerCase()).not.toMatch(/no te (lo )?(voy a |puedo )?(vender|servir)|no es para ti/);
  });

  it('asks the qualifying question instead of ruling out an ambiguous business', async () => {
    const agent = buildFrontDeskAgent();
    const res = await agent.generate(
      [{ role: 'user', content: 'Vengo de Skool. Estoy arrancando un proyecto, ¿me sirve esto?' }],
      { requestContext: rc() },
    );

    // Ambiguous is not a no: it must ask, not park the lead.
    expect(toolIds(res)).not.toContain('updateConversationStatus');
    expect(res.text).toContain('?');
  });
});

describe.skipIf(!evalApiKey)('fit filter — nobody to automate for yet', () => {
  it('parks the conversation in standby, warmly, with the reason attached', async () => {
    const agent = buildFrontDeskAgent();
    const res = await agent.generate(
      [
        { role: 'user', content: 'Vengo de Skool, ¿esto me sirve?' },
        { role: 'assistant', content: 'Para ver si te sirve: ¿hoy te escriben clientes por WhatsApp, Instagram o Facebook?' },
        { role: 'user', content: 'Todavía no, apenas voy a abrir. No tengo negocio ni clientes aún.' },
      ],
      { requestContext: rc() },
    );

    // It closes the loop rather than leaving a lead the follow-up cron will chase.
    expect(toolIds(res)).toContain('updateConversationStatus');
    const args = toolArgs(res, 'updateConversationStatus');
    expect(args?.status).toBe('standby');
    // Without a reason the disqualification is invisible in bot_events (0042).
    expect(String(args?.reason ?? '')).toMatch(/mensaje|cliente|negocio|whatsapp|instagram|facebook/i);
    // And it must not keep selling on the way out.
    expect(toolIds(res)).not.toContain('getAvailability');
  });
});

describe.skipIf(!evalApiKey)('money — the fee never travels without the AI consumption', () => {
  it('discloses both halves the first time price comes up', async () => {
    const agent = buildFrontDeskAgent();
    const res = await agent.generate(
      [{ role: 'user', content: 'Vengo de Skool y tengo una duda, ¿cuánto cuesta?' }],
      { requestContext: rc() },
    );

    const text = res.text.toLowerCase();
    expect(text).toMatch(/\b5\b.*\b30\b|30 (usd|dólares)/); // the founder fee
    expect(text).toMatch(/\bia\b|inteligencia artificial/); // …and the half that is easy to omit
    expect(text).toMatch(/aparte|no incluye|por tu cuenta|corre por/);
  });

  it('sends them to the page instead of naming today\'s price', async () => {
    const agent = buildFrontDeskAgent();
    const res = await agent.generate(
      [
        { role: 'user', content: 'Vengo de Skool. ¿En cuánto va el precio ahorita exactamente? ¿cuántos lugares quedan?' },
      ],
      { requestContext: rc() },
    );

    // The price moves every 5 members, so the only honest answer points at the page.
    expect(res.text).toContain('https://www.skool.com/the-bot-crew');
  });
});

describe.skipIf(!evalApiKey)('the call with Leo is the exception, not the goal', () => {
  it('answers the first doubt without pitching a call', async () => {
    const agent = buildFrontDeskAgent();
    const res = await agent.generate(
      [{ role: 'user', content: 'Vengo de Skool y tengo una duda: ¿qué incluye exactamente?' }],
      { requestContext: rc() },
    );

    // A low-ticket club can't pay for a call on every question — answering IS the job.
    expect(toolIds(res)).not.toContain('getAvailability');
    expect(res.text.toLowerCase()).not.toMatch(/te aparto|agendamos|20 min con leo/);
  });
});

describe.skipIf(!evalApiKey)('a member is not a prospect', () => {
  it('helps without selling the Club back to someone already inside', async () => {
    const agent = buildFrontDeskAgent();
    const res = await agent.generate(
      [
        {
          role: 'user',
          content: 'Vengo de Skool. Ya soy miembro, ¿dónde veo la grabación de la llamada de esta semana?',
        },
      ],
      { requestContext: rc() },
    );

    const text = res.text.toLowerCase();
    expect(text).not.toMatch(/precio de fundador|cuota de fundador|5 a 30|inscríbete|únete/);
    expect(toolIds(res)).not.toContain('getAvailability');
  });
});
