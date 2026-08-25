/**
 * "No sé ese dato" — eval cases for the flagPendingInfo behavior (0050).
 *
 * The old behavior asked permission: "¿quieres que lo pregunte?" / "¿te lo averiguo?".
 * Two costs, and the second is the expensive one:
 *  - to the lead, asking permission to do your job reads as unsure, and her "sí, porfa"
 *    burns a message that moves nothing;
 *  - to us, the gap died in the thread. Nobody learned the config was missing a fact,
 *    so the next lead hit the same wall.
 *
 * The rule now lives in the BASE prompt ("Regla de oro" → "Cuando te preguntan algo que
 * NO tienes"), not in MADI's copy, so these cases gate the product rule for every tenant
 * — MADI is just the fixture that has real facts to contrast against.
 *
 * What's actually under test, in order of importance:
 *  1. it does NOT ask permission (the phrasing the client complained about);
 *  2. it CALLS flagPendingInfo, or the review queue stays empty and nothing improves;
 *  3. it does not over-trigger on a fact the prompt DOES have — a bot that flags
 *     everything is the same as a bot that flags nothing.
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
  ghlConversationId: 'conv_eval_pending_info',
  ghlContactId: 'contact_eval_pending_info',
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

/** The exact shape the client objected to: asking permission to go find out. */
const ASKS_PERMISSION = /(quieres|gustas|te parece|deseas|puedo|quiere)[^.?!]{0,40}(pregunt|averigu|consult|confirm|checar|revis)/;

/**
 * An answer that is genuinely NOT in MADI's config. This used to be "¿puedo pagar con
 * tarjeta o en mensualidades?" — payment became a known fact on 2026-08-25 (the team had
 * answered it by hand in ten threads; see madi-info-gaps.eval.ts), so the case moved to
 * the cancellation policy, which the clinic still has not given us.
 */
const UNKNOWN_ASK = [
  { role: 'user' as const, content: 'Hola, me interesa el facial glow' },
  { role: 'assistant' as const, content: '¡Hola! Soy Majo 😊 ¿Qué te gustaría mejorar de tu piel?' },
  { role: 'user' as const, content: 'Manchas sobre todo. Oye, si me surge algo, ¿cobran por cancelar la cita? ¿Con cuánto tiempo aviso?' },
];

beforeEach(() => vi.clearAllMocks());

describe.skipIf(!evalApiKey)('MADI — a fact the config does not have', () => {
  it('states it will confirm instead of asking permission to ask', async () => {
    const res = await buildFrontDeskAgent().generate(UNKNOWN_ASK, { requestContext: rc() });

    expect(reply(res)).not.toMatch(ASKS_PERMISSION);
    // It has to say SOMETHING about confirming — silence on the question is its own failure.
    expect(reply(res)).toMatch(/confirm|checo|reviso|pregunto|verific/);
  });

  it('flags it for review — the queue is the whole point', async () => {
    const res = await buildFrontDeskAgent().generate(UNKNOWN_ASK, { requestContext: rc() });

    expect(toolIds(res)).toContain('flagPendingInfo');
    // The question travels with it, or the review queue is a list of unlabeled tags.
    expect(String(toolArgs(res, 'flagPendingInfo')?.question ?? '')).toMatch(/cancel|aviso|tiempo/i);
  });

  it('does not hand off — handed_off would mute the bot over a policy question', async () => {
    const res = await buildFrontDeskAgent().generate(UNKNOWN_ASK, { requestContext: rc() });

    expect(toolArgs(res, 'updateConversationStatus')?.status).not.toBe('handed_off');
  });

  it('keeps the conversation moving instead of ending on the unknown', async () => {
    const res = await buildFrontDeskAgent().generate(UNKNOWN_ASK, { requestContext: rc() });

    // House rule: every message ends in a question or a clear next step. "Lo confirmo
    // y te aviso" as the entire reply parks the lead on OUR side of the ball.
    expect(res.text).toMatch(/\?/);
  });
});

describe.skipIf(!evalApiKey)('MADI — it must not flag what it already knows', () => {
  it('answers a price it HAS without flagging anything', async () => {
    const res = await buildFrontDeskAgent().generate(
      [
        { role: 'user', content: 'Quiero depilarme las axilas' },
        { role: 'assistant', content: '¡Va! ¿Se te irrita la piel o te salen bolitas con el rastrillo?' },
        { role: 'user', content: 'Sí, se me irrita. ¿Cuánto cuesta?' },
      ],
      { requestContext: rc() },
    );

    expect(reply(res)).toMatch(/2[.,]?300/);
    expect(toolIds(res)).not.toContain('flagPendingInfo');
  });

  it('a booking request still closes with flagAwaitingHuman, not the info queue', async () => {
    // The two tags feed different people. Crossing them makes both queues useless.
    const res = await buildFrontDeskAgent().generate(
      [
        { role: 'user', content: 'Quiero agendar mi Facial Glow' },
        { role: 'assistant', content: '¡Claro! ¿Te acomoda mejor por la mañana o por la tarde?' },
        { role: 'user', content: 'Por la tarde está perfecto' },
      ],
      { requestContext: rc() },
    );

    expect(toolIds(res)).toContain('flagAwaitingHuman');
    expect(toolIds(res)).not.toContain('flagPendingInfo');
  });
});
