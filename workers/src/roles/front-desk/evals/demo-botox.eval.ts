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
 * MEASURED on gpt-5.6-luna (the platform default), 2026-08-20. Green side: the suite
 * ran 3/3 clean. Red side, deleting from the FIXTURE the rule each case defends:
 *   - price quoted          → 0/3 pass without the price block
 *   - payment answered      → 0/3 pass without the "Pagos y políticas" block
 *   - stays in character    → 0/3 pass with demoPromptOverrides set to null
 *   - offers a real slot    → could not be falsified from config, see that case
 *
 * A fourth case ("does not ask a WhatsApp lead for their number") was written and then
 * DELETED: it passed 3/3 with its rule removed, so it tested nothing. The dangling step 3
 * of the shared booking sequence never made this model ask. The persona keeps the rule —
 * three runs are not proof of absence and the line is free — but no green-either-way case
 * pretends to guard it.
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
 * A demo that dodges the price is a demo of a bot that dodges the price, and price
 * is the first thing a med spa owner tests. The persona carries the numbers exactly
 * so this answer lands in one message.
 */
describe.skipIf(!evalApiKey)('demo botox — answers price straight', () => {
  it('quotes a real botox price instead of deferring to the valoración', async () => {
    const agent = buildFrontDeskAgent();
    const res = await agent.generate(
      [
        { role: 'assistant', content: '¡Hola! Soy Vale, de Alenza Med Spa 😊 ¿Cómo te puedo ayudar hoy?' },
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
        { role: 'assistant', content: '¡Hola! Soy Vale, de Alenza Med Spa 😊 ¿Cómo te puedo ayudar hoy?' },
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
