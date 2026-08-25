/**
 * Treatment-fact eval cases — MADI Skin Care.
 *
 * Facts the clinic gave us that the bot must state, and the line where its
 * knowledge stops. Both halves matter and they are one rule, not two: the
 * `offering` lists pre-session prep for laser AND says the rest (aftercare,
 * spacing between sessions, contraindications) is still unconfirmed. A bot that
 * happily invents aftercare is a worse failure than one that withholds prep —
 * this is a skin clinic, and the anti-hallucination rule is the product.
 *
 * Why prep needed its own case: "cuidados previos y posteriores" used to sit in
 * the offering's "AÚN no tienes confirmado" list. Adding the instructions without
 * removing them from that list leaves the prompt contradicting itself, and the
 * likeliest outcome is the bot deflecting to the valoración anyway — the change
 * would look applied in the DB and be invisible to the lead.
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
  ghlConversationId: 'conv_eval_madi_facts',
  ghlContactId: 'contact_eval_madi_facts',
  channel: 'whatsapp',
};

const rc = () =>
  buildAgentRequestContext({ tenant: madiTenant, turn, provider: evalProvider, model: evalModel, llmApiKey: evalApiKey });

const reply = (res: { text: string }) => res.text.trim().toLowerCase();

beforeEach(() => vi.clearAllMocks());

describe.skipIf(!evalApiKey)('MADI — pre-session instructions for laser', () => {
  it('states both instructions when asked how to prepare', async () => {
    const agent = buildFrontDeskAgent();
    const res = await agent.generate(
      [
        { role: 'user', content: 'Ya tengo mi sesión de láser, ¿cómo me preparo?' },
      ],
      { requestContext: rc() },
    );

    expect(reply(res)).toMatch(/ras[uú]r|afeit/);
    expect(reply(res)).toMatch(/crema/);
    expect(reply(res)).toMatch(/desodorante/);
  });

  it('answers prep without deflecting to the valoración — the fact is known now', async () => {
    const agent = buildFrontDeskAgent();
    const res = await agent.generate(
      [
        { role: 'assistant', content: '¡Hola! Soy Majo, de MADI Skin Care 😊 ¿Cómo te puedo apoyar hoy?' },
        { role: 'user', content: '¿Hay algo que deba hacer antes de mi sesión de depilación?' },
      ],
      { requestContext: rc() },
    );

    expect(reply(res)).toMatch(/ras[uú]r|afeit/);
  });

  it('still refuses to invent AFTERcare, which the clinic never gave us', async () => {
    // The laser context is established on purpose: without it, "¿a cuál sesión te
    // refieres?" is a legitimate answer and the case proves nothing about invention.
    const agent = buildFrontDeskAgent();
    const res = await agent.generate(
      [
        { role: 'user', content: 'Ya tengo mi sesión de depilación láser de axilas el viernes' },
        { role: 'assistant', content: '¡Perfecto! Llega con el área rasurada y sin cremas ni desodorante 🙌' },
        { role: 'user', content: 'Va. Y después de la sesión, ¿qué cuidados debo tener? ¿Me puedo asolear?' },
      ],
      { requestContext: rc() },
    );

    // The property under test is "hands it to a human", not any one phrasing. An
    // earlier, narrower regex went red on "te paso con alguien" — a perfectly good
    // answer — while 6 sampled runs never once invented aftercare. Match the behavior.
    expect(reply(res)).toMatch(/valoraci|especialista|compañera|equipo|confirm|alguien|paso con|persona/);
  });
});

describe.skipIf(!evalApiKey)('MADI — how the 6-session plan is spaced', () => {
  it('says the sessions are monthly when asked how often she has to come', async () => {
    const agent = buildFrontDeskAgent();
    const res = await agent.generate(
      [
        { role: 'user', content: 'Oye, el paquete de axilas, ¿cada cuánto tengo que ir a las sesiones?' },
      ],
      { requestContext: rc() },
    );

    // "al mes" carries "una vez al mes" and "una al mes"; the earlier regex listed
    // exact phrasings and went red on a correct answer. Assert the fact, not the wording.
    expect(reply(res)).toMatch(/al mes|cada mes|mensual|por mes/);
  });
});

describe.skipIf(!evalApiKey)('MADI — the new combined package', () => {
  it('quotes the piernas completas + bikini package once the connection is made', async () => {
    const agent = buildFrontDeskAgent();
    const res = await agent.generate(
      [
        { role: 'user', content: 'Hola, quiero depilarme piernas completas y bikini' },
        { role: 'assistant', content: '¡Claro! ¿Se te irrita la piel o te salen bolitas con el rastrillo?' },
        { role: 'user', content: 'Sí, sobre todo en el bikini. ¿Cuánto sale?' },
      ],
      { requestContext: rc() },
    );

    // $3,800 since 2026-08-25 — the price the team actually charges (it was $3,500 in the list).
    expect(reply(res)).toMatch(/3[.,]?800/);
  });
});

describe.skipIf(!evalApiKey)('MADI — the bikini goes by more than one name', () => {
  // MADI sells ONE bikini zone but leads ask for it as "brasileño" or "completo".
  // Before the naming rule, "bikini completo" fell through to "cualquier zona que no
  // esté escrita arriba: no la cotices" — a real, quotable $2,400 package answered
  // with a deflection to the valoración. Both names must reach the same price.
  for (const zona of ['bikini brasileño', 'bikini completo']) {
    it(`quotes $2,400 for "${zona}"`, async () => {
      const agent = buildFrontDeskAgent();
      const res = await agent.generate(
        [
          { role: 'user', content: `Hola, ¿cuánto cuesta la depilación de ${zona}?` },
          { role: 'assistant', content: '¡Claro! ¿Se te irrita la piel o te salen bolitas con el rastrillo?' },
          { role: 'user', content: 'Sí, bastante. ¿Cuánto sale?' },
        ],
        { requestContext: rc() },
      );

      expect(reply(res)).toMatch(/2[.,]?400/);
      // The failure mode is a deflection, not a wrong number — assert it didn't punt.
      expect(reply(res)).not.toMatch(/no (lo )?(tengo|manejo)|no contamos con/);
    });
  }

  it('does not ask which bikini she means — normal and brasileño share the package price', async () => {
    const agent = buildFrontDeskAgent();
    const res = await agent.generate(
      [
        { role: 'user', content: 'Me interesa el bikini completo, ya me dijeron que sí me sirve' },
        { role: 'assistant', content: '¡Va! ¿Te ha pasado que se te irrita al rasurarte?' },
        { role: 'user', content: 'Sí. ¿Cuánto es?' },
      ],
      { requestContext: rc() },
    );

    expect(reply(res)).toMatch(/2[.,]?400/);
    expect(reply(res)).not.toMatch(/brasileño o|cuál de los dos|a qué te refieres con/);
  });
});
