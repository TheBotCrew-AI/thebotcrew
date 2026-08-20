/**
 * Golden cases for the botox demo persona (Alenza Med Spa) — the roleplay Leo runs
 * live on a call with a med spa owner, entered with the `demo botox` keyword.
 *
 * What makes this suite different from the tenant ones: the demo is watched by the
 * person deciding whether to buy, in real time, with no second take. A demo that
 * dodges a price or breaks character does not produce a bad metric — it produces a
 * lost sale on the call it happened.
 *
 * Live-only (needs an API key); `pnpm eval`, excluded from the CI gate.
 *
 * MEASURED on gpt-5.6-luna (the platform default), 2026-08-20. Green side: 3/3 clean.
 * Red side, breaking the rule each case defends — and the honest result for each:
 *   - opens on the ad       → 0/3 with the PREVIOUS opening restored. Discriminates.
 *   - thank-you dead end    → 1/3 with the old DEMO_FLOW_SECTION. Discriminates.
 *   - price dead end        → 7/8 without the price rule, 10/10 with it. Does NOT
 *                             discriminate: the new DEMO_FLOW_SECTION does the work, and
 *                             the persona rule on top is redundant in every sample taken.
 *   - never re-asks         → 3/3 with the ban deleted. Does NOT discriminate.
 *   - price quoted          → 0/3 without the price block. Discriminates.
 *   - payment answered      → 0/3 without the "Pagos y políticas" block. Discriminates.
 *   - stays in character    → 0/3 with demoPromptOverrides null. Discriminates.
 *   - offers a real slot    → not falsifiable from config; its red side was real all the
 *                             same (see that case).
 *
 * The two non-discriminating cases are kept, unlike the deleted one below, because they
 * are transcribed from the thread where the failure actually happened (conv 1fca0261) —
 * they document a real dead end even where this model no longer reproduces it. Read them
 * as regression guards, not as proof the rule they sit under is load-bearing.
 *
 * Two lessons paid for here, both worth not re-learning:
 *   1. When a case defends a CHANGE rather than a fact, the honest red side is the PREVIOUS
 *      behaviour, not an empty prompt. Deleting the opening rule leaves the case green
 *      (the persona is botox-shaped throughout); restoring the old opening turns it red.
 *   2. Write the assertion against the message that actually failed. The first version of
 *      `advances()` accepted "mentions la valoración" — and the real dead-end message says
 *      "con valoración sin costo", so the case passed on the exact reply that motivated it.
 *
 * A ninth case ("does not ask a WhatsApp lead for their number") was written and DELETED:
 * it passed 3/3 with its rule removed AND had no real incident behind it, which is the
 * difference between it and the two kept above. The persona keeps the rule; no case pretends
 * to guard it.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../db/queries.js');
vi.mock('../../../ghl/client.js', () => ({
  GhlClient: vi.fn(() => ({ addContactTags: vi.fn().mockResolvedValue(undefined) })),
}));

import * as q from '../../../db/queries.js';
import { buildFrontDeskAgent } from '../agent.js';
import { buildAgentRequestContext } from '../../../core/runtime-context.js';
import type { TurnContext } from '../../../core/types.js';
import { simulatedSlots } from '../tools/demo-sim.js';
import { botCrewDemoTenant } from './fixtures.js';
import { evalApiKey, evalModel, evalProvider } from './eval-model.js';

const CONV = 'conv_eval_demo_botox';
const TZ = 'America/Tijuana';

/** activeRole='demo' is what swaps in the persona AND simulates the calendar. */
const turn: TurnContext = {
  ghlConversationId: CONV,
  ghlContactId: 'contact_eval_demo_botox',
  channel: 'whatsapp',
  activeRole: 'demo',
};

const rc = () =>
  buildAgentRequestContext({
    tenant: botCrewDemoTenant,
    turn,
    provider: evalProvider,
    model: evalModel,
    llmApiKey: evalApiKey,
  });

const reply = (res: { text: string }) => res.text.trim().toLowerCase();

type ToolCallChunkLike = { payload: { toolName: string; args?: unknown } };
const toolIds = (res: { toolCalls?: ToolCallChunkLike[] }): string[] =>
  (res.toolCalls ?? []).map((c) => c.payload.toolName);

/**
 * The same slots the tool will hand the model: the simulator is deterministic per
 * (conversation, day), so the case can assert the reply used a REAL slot instead of
 * a plausible-looking invented one. Recomputed per run because the window moves.
 */
const simSlots = () => simulatedSlots(CONV, TZ, Date.now());

/**
 * Does the reply name a day and a time that belong to the SAME simulated slot?
 * Checking "some weekday appears" and "some time appears" separately is much weaker:
 * the simulator offers the same five times every day, so an invented "sábado a la
 * 1:00" would satisfy both halves on a day that has no 1:00 free.
 */
const offersRealSlot = (text: string): boolean =>
  simSlots().some((slot) => {
    const weekday = slot.label.split(',')[0]!.toLowerCase();
    const time = slot.label.match(/\d{1,2}:\d{2}/)?.[0] ?? '';
    return !!time && text.includes(weekday) && text.includes(time);
  });

beforeEach(() => {
  vi.clearAllMocks();
  // The demo branches of getAvailability/bookAppointment read the session before
  // simulating, and the automock returns undefined — `.catch()` on which throws
  // INSIDE the tool. The model then apologises that the calendar won't load, and a
  // case asserting on what it offered fails for a reason that has nothing to do with
  // the prompt. Give it the null a real manual demo (no session) actually returns.
  vi.mocked(q.getActiveDemoSession).mockResolvedValue(null);
  vi.mocked(q.logBotEvent).mockResolvedValue(undefined);
});

/**
 * The one failure that cannot be walked back: the prospect is a med spa owner being
 * sold to, and the roleplay is the pitch. A "Club Fundador" or a "Leo" surfacing
 * mid-demo tells them the product leaks its own vendor into a client's conversation.
 *
 * This case is insurance, not a fix for an observed bug — the demo overrides replace
 * the base ones wholesale (resolveEffectiveOverrides), so the Club's text is not in
 * the prompt at all. It fires if that precedence ever breaks. The FAQ half of the
 * same leak (lookupFaq reaching our answers from inside the roleplay) is covered
 * deterministically in lookup-faq.test.ts, not here.
 */
describe.skipIf(!evalApiKey)('demo botox — stays in character', () => {
  it('never names The Bot Crew, the Club, Leo or the skool link', async () => {
    const agent = buildFrontDeskAgent();
    const res = await agent.generate(
      [{ role: 'user', content: 'oye, ¿eres una persona real o un bot?' }],
      { requestContext: rc() },
    );

    expect(reply(res)).not.toMatch(/bot crew|club fundador|skool|fundador|\bleo\b/);
    expect(reply(res)).toMatch(/alenza|asistente|virtual/);
  });
});

/**
 * The opening is the whole conceit of this demo: `demo botox` stands in for a lead
 * arriving from the ad, so the first reply has to read like an instant reply to
 * "vi su anuncio, quiero info de bótox" — not like a receptionist asking a stranger
 * what they need. An open "¿cómo te puedo ayudar?" tells the med spa owner watching
 * that the bot ignored where the lead came from, which is the one thing the campaign
 * is selling.
 *
 * The second half is the guard against the failure this repo keeps re-learning: the
 * opening must NOT reach for the appointment. Offering a slot to someone who has said
 * one word is the aggressive-close behaviour that made earlier personas read as bots.
 */
describe.skipIf(!evalApiKey)('demo botox — opens like an answer to the ad', () => {
  it('answers the ad instead of asking what they need, and does not pitch the appointment yet', async () => {
    const agent = buildFrontDeskAgent();
    const res = await agent.generate(
      [{ role: 'user', content: 'demo botox' }],
      { requestContext: rc() },
    );

    // Knows what they came for.
    expect(reply(res)).toMatch(/botox|bótox/);
    // Does not open with the generic question the ad already answered.
    expect(reply(res)).not.toMatch(/en qué te (puedo )?ayud|cómo te puedo (ayudar|apoyar)|qué necesitas|qué te trae/);
    // Does not reach for the calendar on message one.
    expect(toolIds(res)).not.toContain('getAvailability');
    expect(reply(res)).not.toMatch(/\d{1,2}:\d{2}/);
  });
});

/**
 * A demo that dodges the price is a demo of a bot that dodges the price, and price
 * is the first thing a med spa owner tests. The persona carries the numbers exactly
 * so this answer lands in one message.
 */
describe.skipIf(!evalApiKey)('demo botox — answers price straight', () => {
  it('quotes a real botox price instead of deferring to the valoración', async () => {
    const agent = buildFrontDeskAgent();
    const res = await agent.generate(
      [
        { role: 'assistant', content: '¡Hola! 👋 Soy Vale, de Alenza Med Spa. ¿Ya traes una zona en mente para el bótox o prefieres que el médico te diga qué te conviene?' },
        { role: 'user', content: 'hola, ¿cuánto cuesta el botox?' },
      ],
      { requestContext: rc() },
    );

    expect(reply(res)).toMatch(/2[,.]?900|5[,.]?200|6[,.]?900|140/);
  });

  it('answers an off-script question about payment from the persona', async () => {
    const agent = buildFrontDeskAgent();
    const res = await agent.generate(
      [{ role: 'user', content: '¿aceptan tarjeta o nada más efectivo?' }],
      { requestContext: rc() },
    );

    expect(reply(res)).toMatch(/tarjeta/);
    // The tell of a demo that has run out of material: promising to find out.
    expect(reply(res)).not.toMatch(/lo confirmo|te confirmo|pregunto|averiguo/);
  });
});

/**
 * Proactive without going quiet — both cases are lifted VERBATIM from the thread where
 * Leo watched the demo die (2026-08-20, conv 1fca0261), not invented. That matters: the
 * invented versions of these two ("the lead says 'ah ok'") passed 3/3 with the rule
 * removed, because this model handles a bare acknowledgment fine. The real dead ends were
 * more specific, and only the real ones discriminate.
 *
 * Both were produced by the FIRST DEMO_FLOW_SECTION, which bought variety with "a veces
 * contesta y ya, sin cierre". In a demo watched by the person deciding whether to buy, a
 * bot that stalls right after the price is the worst possible moment to stall.
 */
describe.skipIf(!evalApiKey)('demo botox — never leaves the conversation in the air', () => {
  /**
   * A move = a question, a concrete time, or an actual invitation to book. Deliberately
   * NOT "mentions la valoración": the first version accepted that, and the real dead-end
   * message ("$2,900, con valoración sin costo y retoque incluido.") contains the word —
   * so the case passed on the exact message that motivated it. Naming the service is
   * describing what you sell; proposing a step is asking for the next move.
   */
  const advances = (text: string) => /\?/.test(text) || /\d{1,2}:\d{2}/.test(text) || /agend|apart|reserv/.test(text);

  it('proposes a next step right after quoting the price, with the zone already known', async () => {
    // The real failure: "Sí, depende de las zonas. Si es únicamente patas de gallo,
    // corresponde a una zona: $2,900, con valoración sin costo y retoque incluido." — and
    // nothing else. She had already named her zone; there was nothing left to qualify.
    const agent = buildFrontDeskAgent();
    const res = await agent.generate(
      [
        { role: 'user', content: 'Demo Botox' },
        { role: 'assistant', content: '¡Hola! 👋 Soy Vale, de Alenza Med Spa. ¿Ya traes una zona en mente para el bótox o prefieres que el médico te diga qué te conviene?' },
        { role: 'user', content: 'Que zonas manejan?' },
        { role: 'assistant', content: 'Manejamos entrecejo, frente, patas de gallo, cuello, mentón y sonrisa gingival. ¿Cuál te interesa suavizar?' },
        { role: 'user', content: 'Principalmente mis patas de gallo' },
        { role: 'user', content: 'Cambia el precio por zona?' },
      ],
      { requestContext: rc() },
    );

    expect(reply(res)).toMatch(/2[,.]?900/); // still answers the question
    expect(advances(reply(res)), `dead end: ${res.text}`).toBe(true);
  });

  it('does not answer a thank-you with "aquí estoy cuando quieras"', async () => {
    // The real closing message. It reads polite and it ends the funnel: the lead is warm,
    // the zone is known, the price is out, and the bot hands the next move back to her.
    const agent = buildFrontDeskAgent();
    const res = await agent.generate(
      [
        { role: 'user', content: 'Principalmente mis patas de gallo' },
        { role: 'assistant', content: 'Si es únicamente patas de gallo, corresponde a una zona: $2,900, con valoración sin costo y retoque a los 15 días incluido.' },
        { role: 'user', content: 'Okok gracias' },
      ],
      { requestContext: rc() },
    );

    expect(reply(res)).not.toMatch(/aquí estoy|aqui estoy|cuando (quieras|gustes)|cualquier (cosa|duda) (me )?(dime|dices|avisas)/);
    expect(advances(reply(res)), `dead end: ${res.text}`).toBe(true);
  });

  it('does not re-ask a closing question the lead already dodged', async () => {
    const agent = buildFrontDeskAgent();
    const res = await agent.generate(
      [
        { role: 'assistant', content: '¿Quieres que te muestre los horarios que tengo?' },
        { role: 'user', content: 'oye y el bótox duele?' },
      ],
      { requestContext: rc() },
    );

    expect(reply(res)).not.toMatch(/quieres que te (muestre|comparta|pase) los horarios/);
  });
});

/**
 * The booking is the moment the demo is FOR: the prospect watches a slot get taken
 * without a human. The slots must come from the simulator — a model that invents a
 * plausible time is exactly the failure the whole availability contract exists to
 * prevent, and here it would be invisible until someone checked the calendar.
 *
 * Not falsifiable from the fixture: the availability contract lives in BOOKING_SECTIONS
 * (code), so deleting the persona's getAvailability instruction changed nothing — the
 * model called the tool anyway, 2/2. Its red side is real all the same, just not staged:
 * it caught the tool THROWING (the automock returns undefined and the demo branch calls
 * `.catch()` on it), where the model answered "estoy revisando la agenda, pero no me está
 * cargando" and offered no time at all. That is the failure this case is for.
 */
describe.skipIf(!evalApiKey)('demo botox — books like a real front desk', () => {
  it('checks availability and offers a slot the simulator actually returned', async () => {
    const agent = buildFrontDeskAgent();
    const res = await agent.generate(
      [
        { role: 'assistant', content: '¡Hola! 👋 Soy Vale, de Alenza Med Spa. ¿Ya traes una zona en mente para el bótox o prefieres que el médico te diga qué te conviene?' },
        { role: 'user', content: 'quiero agendar la valoración para botox' },
      ],
      { requestContext: rc() },
    );

    expect(toolIds(res)).toContain('getAvailability');
    expect(offersRealSlot(reply(res)), `no real slot in: ${res.text}`).toBe(true);
    // The simulator closes Sundays; the persona says so too.
    expect(reply(res)).not.toMatch(/domingo/);
  });

});
