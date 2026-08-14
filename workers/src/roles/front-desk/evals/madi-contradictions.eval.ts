/**
 * Contradiction-repair eval cases — MADI Skin Care (2026-08-02 prompt audit).
 *
 * Three places where the assembled prompt argued with itself. Each is here
 * because reading the text is not enough to know which side the model picks.
 *
 * 1. `toolInstructions` still said "cierra con updateConversationStatus(handed_off)"
 *    — written before `flagAwaitingHuman` existed — while the base section said, in
 *    bold, never to use handed_off for a booking request. Whichever side won, one
 *    of them was dead text; if the stale one won, every lead who asked for an
 *    appointment left the bot PERMANENTLY MUTE and never got the tag that puts them
 *    in MADI's work queue. This is the same dead end recorded on 2026-07-29.
 *
 * 2. "Piernas completas no tiene precio de paquete" sat above four packages that
 *    contain piernas completas — including the $3,500 one added the day before.
 *
 * 3. `lookupFaq` is instructed to run before answering any general question
 *    "(precios, tiempos...)", and MADI's promo answer contains "$999". That is a
 *    path to a first price with no connecting question — the rule from
 *    connect-before-price.eval.ts, leaking through a tool.
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
  ghlConversationId: 'conv_eval_madi_contra',
  ghlContactId: 'contact_eval_madi_contra',
  channel: 'whatsapp',
};

const rc = () =>
  buildAgentRequestContext({ tenant: madiTenant, turn, provider: evalProvider, model: evalModel, llmApiKey: evalApiKey });

type ToolCallChunkLike = { payload: { toolName: string; args?: unknown } };
const toolIds = (res: { toolCalls?: ToolCallChunkLike[] }): string[] =>
  (res.toolCalls ?? []).map((c) => c.payload.toolName);
const toolArgs = (res: { toolCalls?: ToolCallChunkLike[] }, name: string): Record<string, unknown> | undefined =>
  (res.toolCalls ?? []).find((c) => c.payload.toolName === name)?.payload.args as Record<string, unknown> | undefined;

const reply = (res: { text: string }) => res.text.trim().toLowerCase();

/** The lead has answered the morning/afternoon question — the turn that closes. */
const READY_TO_CLOSE = [
  { role: 'user' as const, content: 'Quiero agendar mi Facial Glow' },
  { role: 'assistant' as const, content: '¡Claro! ¿Te acomoda mejor por la mañana o por la tarde?' },
  { role: 'user' as const, content: 'Por la tarde está perfecto' },
];

beforeEach(() => vi.clearAllMocks());

describe.skipIf(!evalApiKey)('MADI — a booking request must not mute the bot', () => {
  it('closes with flagAwaitingHuman, never with handed_off', async () => {
    const res = await buildFrontDeskAgent().generate(READY_TO_CLOSE, { requestContext: rc() });

    expect(toolIds(res)).toContain('flagAwaitingHuman');
    // The crux. handed_off here is not a worse close — it is a permanently silent bot.
    expect(toolArgs(res, 'updateConversationStatus')?.status).not.toBe('handed_off');
  });

  it('never books or reads a calendar this tenant does not have', async () => {
    const res = await buildFrontDeskAgent().generate(READY_TO_CLOSE, { requestContext: rc() });

    expect(toolIds(res)).not.toContain('bookAppointment');
    expect(toolIds(res)).not.toContain('getAvailability');
  });
});

describe.skipIf(!evalApiKey)('MADI — piernas completas: the package exists combined, not alone', () => {
  it('quotes the combined package instead of refusing it', async () => {
    const res = await buildFrontDeskAgent().generate(
      [
        { role: 'user', content: 'Quiero piernas completas con bikini' },
        { role: 'assistant', content: '¿Se te irrita la piel o te salen bolitas con el rastrillo?' },
        { role: 'user', content: 'Sí. ¿Cuánto sale ese paquete?' },
      ],
      { requestContext: rc() },
    );

    expect(reply(res)).toMatch(/3[.,]?500/);
  });

  it('still refuses to invent a package price for piernas completas alone', async () => {
    const res = await buildFrontDeskAgent().generate(
      [
        { role: 'user', content: 'Solo piernas completas, nada más. Ya sé que me irrito.' },
        { role: 'assistant', content: 'Entiendo, para eso el láser funciona muy bien.' },
        { role: 'user', content: '¿Cuánto cuesta el paquete de 6 sesiones de piernas completas?' },
      ],
      { requestContext: rc() },
    );

    // The invented number would be a plausible-looking package price. The two real
    // figures it MAY say are the per-session $1,000 and the $3,500 combined package.
    const invented = reply(res).match(/\$\s?\d[\d.,]{2,}/g)?.filter(
      (m) => !/1[.,]?000|3[.,]?500/.test(m),
    );
    expect(invented ?? [], `inventó un precio de paquete: ${invented?.join(', ')}`).toHaveLength(0);
  });
});

describe.skipIf(!evalApiKey)('MADI — a price reached through lookupFaq is still a first price', () => {
  it('does not relay the $999 promo before the connecting question', async () => {
    const res = await buildFrontDeskAgent().generate(
      [
        { role: 'assistant', content: '¡Hola! Soy Majo, de MADI Skin Care 😊 ¿Cómo te puedo apoyar hoy?' },
        { role: 'user', content: 'Hola, ¿qué promociones tienen en faciales?' },
      ],
      { requestContext: rc() },
    );

    expect(reply(res)).not.toMatch(/999/);
    expect(reply(res)).toContain('?');
  });
});
