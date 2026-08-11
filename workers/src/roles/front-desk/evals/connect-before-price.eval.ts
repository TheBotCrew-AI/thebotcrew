/**
 * Consultative-price eval cases — MADI Skin Care.
 *
 * The client's ask (2026-08-01): don't lead with a number. Connect first — for a
 * facial, what she wants to fix; for laser, which zone and whether it irritates —
 * so the price lands on a need she already said out loud.
 *
 * That ask has an obvious failure mode, and it is the expensive one: a bot that
 * turns "¿cuánto cuesta?" into an interrogation, or that keeps deferring the number
 * until she leaves. So the rule is bounded — ONE connecting question, ever — and
 * these cases pull in both directions on purpose:
 *   · under-connecting: quoting cold, which is the behavior the client complained about;
 *   · over-connecting: withholding a price from someone who asked twice, dodged the
 *     question, or already told us what she needs. That one loses the lead, so every
 *     case below except the first asserts the NUMBER shows up.
 *
 * ⚠️ The first case is NOT deterministic. It holds about **85%** of the time (13 runs
 * on `gpt-5-mini`; re-measured at 9/11 on `gpt-5.6-luna` at a high reasoning effort —
 * the rate did not move); the other ~15% quotes cold. Treat a single failure as the
 * known rate, not a regression — re-run 5-6 times before touching the prompt. Raising
 * the effort is not the lever. The failure is benign by design: quoting cold
 * is exactly what the bot did before this rule existed, so the downside is a lost
 * bit of value-framing, never a wrong price or a stuck lead. Raising it further
 * means a stronger model for this tenant (`tenant_config.ai_model`), which the
 * client pays for at cost — Leo's call, not a prompt problem.
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
import type { TurnContext } from '../../../core/types.js';
import { madiTenant } from './fixtures.js';
import { evalApiKey, evalModel, evalProvider } from './eval-model.js';

const turn: TurnContext = {
  ghlConversationId: 'conv_eval_madi',
  ghlContactId: 'contact_eval_madi',
  channel: 'whatsapp',
};

const rc = () =>
  buildAgentRequestContext({ tenant: madiTenant, turn, provider: evalProvider, model: evalModel, llmApiKey: evalApiKey });

/** Any peso amount: "$2,300", "2300", "2,300 pesos". Deliberately loose — the point
 *  is whether a NUMBER was handed over at all, not which one. */
const PRICE = /\$\s?\d|\b\d{3,4}\b|\b\d[.,]\d{3}\b/;

const reply = (res: { text: string }) => res.text.trim();

beforeEach(() => vi.clearAllMocks());

describe.skipIf(!evalApiKey)('MADI — connect before quoting', () => {
  it('a cold price question earns a connecting question, not a number', async () => {
    const agent = buildFrontDeskAgent();
    const res = await agent.generate(
      [
        { role: 'assistant', content: '¡Hola! Soy Majo, de MADI Skin Care 😊 ¿Cómo te puedo apoyar hoy?' },
        { role: 'user', content: 'Hola, ¿cuánto cuesta la depilación de axilas?' },
      ],
      { requestContext: rc() },
    );

    expect(reply(res)).not.toMatch(PRICE);
    expect(reply(res)).toContain('?');
    // The connection has to be about HER case, not a generic stall ("¿me das un momento?").
    expect(reply(res).toLowerCase()).toMatch(/irrit|rastrillo|cera|bolitas|zona|molest/);
  });

  it('answers the number when she already said what she needs — that IS the connection', async () => {
    const agent = buildFrontDeskAgent();
    const res = await agent.generate(
      [
        { role: 'assistant', content: '¡Hola! Soy Majo, de MADI Skin Care 😊 ¿Cómo te puedo apoyar hoy?' },
        {
          role: 'user',
          content:
            'Me irrito muchísimo de las axilas con el rastrillo, me salen bolitas. ¿Cuánto me sale la depilación láser de axilas?',
        },
      ],
      { requestContext: rc() },
    );

    expect(reply(res)).toMatch(PRICE);
  });
});

describe.skipIf(!evalApiKey)('MADI — the guardrail: never make her ask twice', () => {
  it('gives the price when she asks a second time', async () => {
    const agent = buildFrontDeskAgent();
    const res = await agent.generate(
      [
        { role: 'user', content: '¿Cuánto cuesta la depilación de axilas?' },
        { role: 'assistant', content: '¡Claro! Cuéntame, ¿se te irrita o te salen bolitas con el rastrillo o la cera?' },
        { role: 'user', content: 'Nada más quiero saber el precio' },
      ],
      { requestContext: rc() },
    );

    expect(reply(res)).toMatch(PRICE);
  });

  it('gives the price when she dodges the connecting question and repeats hers', async () => {
    const agent = buildFrontDeskAgent();
    const res = await agent.generate(
      [
        { role: 'user', content: 'Hola, info de facial porfa' },
        { role: 'assistant', content: '¡Hola! ¿Qué te gustaría mejorar de tu piel? ¿Acné, manchas, resequedad?' },
        { role: 'user', content: 'No sé, ¿cuánto cuestan?' },
      ],
      { requestContext: rc() },
    );

    expect(reply(res)).toMatch(PRICE);
  });

  it('does not re-open the discovery phase after a price was already given', async () => {
    // The "eternal connecting" failure the client explicitly did not want. One question
    // after the quote is the flow (it must move toward the valoración); two is an interrogation.
    const agent = buildFrontDeskAgent();
    const res = await agent.generate(
      [
        { role: 'user', content: '¿Cuánto cuesta axilas?' },
        { role: 'assistant', content: '¿Se te irrita con el rastrillo?' },
        { role: 'user', content: 'Sí, bastante' },
        { role: 'assistant', content: 'Para eso el láser va perfecto: axilas son $2,300 el paquete de 6 sesiones.' },
        { role: 'user', content: '¿Y medias piernas?' },
      ],
      { requestContext: rc() },
    );

    expect(reply(res)).toMatch(PRICE);
    expect(reply(res).match(/\?/g)?.length ?? 0).toBeLessThanOrEqual(1);
  });
});
