/**
 * A human teammate answered inside the thread — the bot must treat it as the answer.
 *
 * MADI, 2026-08-26 (conversation c8b37f38…): a mother asked whether her 17-year-old could
 * get laser; the bot flagged it (pending_info + awaiting_human). An hour later a person
 * from the clinic replied "sí se puede, sólo debe acompañarla un adulto" and offered
 * "sábado 9:30 am o 12:30 pm". The lead picked 12:30 — and the bot answered "el equipo te
 * confirmará la cita y el requisito para tu hija". Twice.
 *
 * Root cause: `human_agent` messages reached the model as bare `assistant` turns, so the
 * team's answer read as the bot's own words — which its prompt forbids (no times, no facts
 * it doesn't have), so it discarded them. Fix: `toModelMessages` marks them with
 * HUMAN_REPLY_PREFIX and the prompt's "Una persona del equipo ya intervino" section reads
 * them as the official answer.
 *
 * Shown failing first (gpt-5.6-luna, high effort, 3 runs per side, 2026-08-26).
 * `EVAL_HUMAN_REPLY_BEFORE=1` replays the pre-fix model view (unmarked history, no prompt
 * section):
 *   before: "chosen slot" 0/3 (12:30 never reached the team; twice no flagAwaitingHuman at
 *           all), "does not defer the age answer" 2/3 — the third run produced the incident
 *           sentence verbatim ("te confirmará … el requisito de acompañamiento").
 *   after:  9/9 — every run relayed 12:30 via flagAwaitingHuman and re-stated
 *           "debe acompañarla un adulto" as a fact.
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
import { toModelMessages } from '../../../core/model-messages.js';
import type { ConversationMessage, TurnContext } from '../../../core/types.js';
import { madiTenant } from './fixtures.js';
import { evalApiKey, evalModel, evalProvider } from './eval-model.js';

const BEFORE = process.env.EVAL_HUMAN_REPLY_BEFORE === '1';

const turn: TurnContext = {
  ghlConversationId: 'conv_eval_human_reply',
  ghlContactId: 'contact_eval_human_reply',
  channel: 'whatsapp',
  hasHumanReplies: !BEFORE,
};

const rc = () =>
  buildAgentRequestContext({ tenant: madiTenant, turn, provider: evalProvider, model: evalModel, llmApiKey: evalApiKey });

const at = (hhmm: string) => `2026-08-26T${hhmm}:00-07:00`;
const lead = (content: string, t: string): ConversationMessage => ({ direction: 'inbound', senderType: 'lead', content, sentAt: at(t) });
const bot = (content: string, t: string): ConversationMessage => ({ direction: 'outbound', senderType: 'bot', content, sentAt: at(t) });
const human = (content: string, t: string): ConversationMessage => ({
  direction: 'outbound',
  senderType: 'human_agent',
  humanAgentId: 'h_madi',
  content,
  sentAt: at(t),
});

/** The real thread, verbatim (phone dropped). */
const THREAD: ConversationMessage[] = [
  lead('Hola tienes  el costo de depilación  láser media pierna', '14:59'),
  bot('El paquete de media pierna cuesta $2,300 por 6 sesiones. Normalmente es una sesión cada mes.', '14:59'),
  bot('¿Te gustaría agendarla por la mañana o por la tarde?', '14:59'),
  lead('Es para mi hija ella es menor de edad tiene 17', '15:00'),
  lead('Se puede', '15:00'),
  bot('Déjame confirmar con el equipo si puede realizarse a los 17 años y si necesita autorización o acompañamiento de mamá, papá o tutor. Te aviso en cuanto lo tenga.', '15:00'),
  lead('Por la mañana tienes disponible  el sabado', '15:00'),
  bot('Voy a revisar la disponibilidad del sábado por la mañana y te confirmo en un momento. También validaré el requisito para su sesión por tener 17 años.', '15:01'),
  lead('De acuerdo  , gracias', '15:01'),
  bot('¡Con gusto! Dejé solicitada la depilación de media pierna para el sábado por la mañana. Una persona del equipo te confirmará la disponibilidad y el requisito para su edad.', '15:01'),
  human('Hola!. Si se puede realizar la depilación con 17 años, sólo debe acompañarla un adulto.', '16:10'),
  human('El sabado podría ser a las 9:30 am o 12:30 pm', '16:12'),
  lead('12 30 estas ubicados en Zona Rio', '17:36'),
];

/** Pre-fix view: every non-lead turn is a bare assistant message. */
const legacyView = (h: ConversationMessage[]) =>
  h.map((m) => (m.senderType === 'lead' ? { role: 'user' as const, content: m.content } : { role: 'assistant' as const, content: m.content }));

const messages = () => (BEFORE ? legacyView(THREAD) : toModelMessages(THREAD));

type ToolCallChunkLike = { payload: { toolName: string; args?: unknown } };
const toolIds = (res: { toolCalls?: ToolCallChunkLike[] }): string[] =>
  (res.toolCalls ?? []).map((c) => c.payload.toolName);
const toolArgs = (res: { toolCalls?: ToolCallChunkLike[] }, name: string): Record<string, unknown> | undefined =>
  (res.toolCalls ?? []).find((c) => c.payload.toolName === name)?.payload.args as Record<string, unknown> | undefined;

/**
 * The sentence the client saw: a deferral verb and the age topic in the SAME sentence
 * ("el equipo te confirmará … el requisito de acompañamiento"). Sentence-scoped on purpose:
 * a good reply says "le paso al equipo tu elección de las 12:30" AND, separately,
 * "recuerda que debe acompañarla un adulto" — that pair must not trip it. The split
 * requires an uppercase start, so "12:30 p.m. y el requisito" stays one sentence.
 */
const DEFERRAL = /confirm|valid|revis|checa|pendiente|te aviso/;
const AGE_TOPIC = /requisito|edad|17|menor|hija|acompañ/;
const sentences = (text: string) => text.split(/(?<=[.!?])\s+(?=[A-ZÁÉÍÓÚÑ¿¡])/);
const defersTheAgeAnswer = (text: string) =>
  sentences(text).some((s) => DEFERRAL.test(s.toLowerCase()) && AGE_TOPIC.test(s.toLowerCase()));

beforeEach(() => vi.clearAllMocks());

describe.skipIf(!evalApiKey)('MADI — the team already answered in the thread', () => {
  it('does not promise to confirm what the team already confirmed', async () => {
    const res = await buildFrontDeskAgent().generate(messages(), { requestContext: rc() });
    expect(defersTheAgeAnswer(res.text), res.text).toBe(false);
  });

  it("passes the lead's chosen slot to the team instead of parking her again", async () => {
    const res = await buildFrontDeskAgent().generate(messages(), { requestContext: rc() });
    // No booking tools on this tenant: the hand-off is flagAwaitingHuman carrying 12:30.
    expect(toolIds(res)).toContain('flagAwaitingHuman');
    expect(JSON.stringify(toolArgs(res, 'flagAwaitingHuman') ?? {})).toMatch(/12[:.]?30/);
    expect(res.text.toLowerCase()).toMatch(/12[:.]?30/);
  });

  it('does not re-flag the age question as pending info', async () => {
    const res = await buildFrontDeskAgent().generate(messages(), { requestContext: rc() });
    expect(toolIds(res)).not.toContain('flagPendingInfo');
  });
});
