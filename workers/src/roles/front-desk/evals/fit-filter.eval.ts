/**
 * Golden cases for The Bot Crew's own funnel — the response system ($500/mes, 2026-09-07).
 *
 * The offer changed shape: Leo stopped selling the Botox Sprint (ads + lead gen + a
 * 10-appointment guarantee at $3,000/mo) and now sells only the answering system —
 * WhatsApp, Facebook and Instagram answered 24/7, booking when the business takes
 * appointments, follow-up on whoever goes quiet. His work is free; the $500 a month are the
 * tools he pays for on the client's behalf. The rules those cases defended (the fit filter
 * that could disqualify, the ad-spend disclosure, the guarantee's boundary) are GONE from
 * prod, so the cases that defended them are gone from here — a case that pins deleted text
 * is worse than no case: it stays green forever and reads as coverage.
 *
 * What survives, restated for the new offer:
 *
 *   · NOBODY GETS RULED OUT. There is no qualification step any more — the goal is to
 *     understand the business and book the call, and whether it applies is Leo's call on
 *     the call. The one honest carve-out (a shop that closes sales inside the chat) is
 *     told the truth without being shown the door.
 *
 *   · THE PRICE IS TWO FACTS, NOT ONE. "$500 al mes" alone is the half that makes the offer
 *     sound like a cheap bot. The other half — Leo's work is free and the $500 are the
 *     tools — is what makes the number believable, and it has to travel in the SAME message.
 *
 *   · WHAT IS NO LONGER SOLD. Ads and lead generation left the offer but not the world:
 *     it is the single likeliest thing for a model to agree to, because every AI agency
 *     does it and the previous prompt did too.
 *
 * The tools are mocked inert: these cases assert on which tools the model REACHES FOR, so
 * nothing may touch the real DB or GHL.
 *
 * What each case is worth (§6c: a case not shown FAILING without its rule proves nothing).
 * Measured on `gpt-5.6-luna`, 2026-09-07:
 *   · "no vende anuncios ni generación de leads" — the one NEW rule here, measured on both
 *     sides, and it does NOT discriminate: 3/3 with the rule, and 3/3 again with all THREE
 *     places that carry it deleted from the fixture (the "# Lo que este servicio NO incluye"
 *     section, the houseRules absolute rule, and the FAQ ficha). Removing only the offering
 *     section would have been the half-revert the old header warned about, so the red side
 *     took all three — and the model still answered "hoy no manejamos anuncios ni
 *     conseguimos clientes nuevos", because the rest of the offering describes a system that
 *     works on the messages a business ALREADY gets, and that is enough. So this is a GUARD
 *     on the most expensive available mistake, not proof that the wording produces the
 *     refusal. The rule stays in prod: redundancy is cheap and the failure is not.
 *   · Every other case is a PORT of a case that already existed, re-pointed at the new
 *     numbers, and its red side has NOT been re-measured against this offer. They are
 *     guards too: they hold the behavior we have, and the honest record is that they were
 *     green 1/1 the day the offer changed, not that the wording produces the behavior.
 *     The info-dump/stall case keeps the most history behind it (see git history of this
 *     file for the 2026-08-20 measurements under the old offer).
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

// A WhatsApp lead arrives WITH a phone, and the prompt branches on it: with one, the
// reminder section says "just book"; without, it tells the agent to ask for the number
// before booking. Leaving it out builds a prompt production never renders — cases here
// were being measured against a shape no real lead of this campaign produces.
const turn: TurnContext = {
  ghlConversationId: 'conv_eval_fit',
  ghlContactId: 'contact_eval_fit',
  contactPhone: '+5216641234567',
  channel: 'whatsapp',
};

const rc = (tenant: TenantContext = botCrewTenant) =>
  buildAgentRequestContext({ tenant, turn, provider: evalProvider, model: evalModel, llmApiKey: evalApiKey });

type ToolCallChunkLike = { payload: { toolName: string; args?: unknown } };

/** Tool ids the model asked for this run, in call order (Mastra wraps them in a chunk). */
function toolIds(res: { toolCalls?: ToolCallChunkLike[] }): string[] {
  return (res.toolCalls ?? []).map((c) => c.payload.toolName);
}

const reply = (res: { text: string }) => res.text.toLowerCase();

beforeEach(() => vi.clearAllMocks());

describe.skipIf(!evalApiKey)('nobody gets ruled out', () => {
  it('takes a business that already gets messages, without qualifying it to death', async () => {
    const agent = buildFrontDeskAgent();
    const res = await agent.generate(
      [
        {
          role: 'user',
          content:
            'Hola, vi su anuncio. Tengo un consultorio dental chiquito. Me escriben por WhatsApp pero a veces tardo en contestar. ¿Esto me sirve?',
        },
      ],
      { requestContext: rc() },
    );

    expect(toolIds(res)).not.toContain('updateConversationStatus');
    expect(reply(res)).not.toMatch(/no te (lo )?(voy a |puedo )?(vender|servir)|no es para ti/);
  });

  // Ambiguous is not negative, and under this offer nothing is negative: the business that
  // is "apenas empezando" still gets messages, or will. A question costs one message; a
  // disqualification costs the lead permanently and silently.
  it('asks instead of concluding when the business is ambiguous', async () => {
    const agent = buildFrontDeskAgent();
    const res = await agent.generate(
      [{ role: 'user', content: 'Hola, tengo un negocio pero apenas vamos empezando. ¿Esto me sirve o todavía no?' }],
      { requestContext: rc() },
    );

    expect(toolIds(res)).not.toContain('updateConversationStatus');
    expect(res.text).toContain('?');
  });

  // Fuera del avatar, dentro del criterio (2026-09-01, mantenido bajo la oferta nueva): una
  // podóloga real escribió y el filtro viejo la descalificaba por giro. Hoy el criterio es
  // todavía más ancho —cualquier negocio que reciba mensajes— así que descartarla sería
  // doblemente falso.
  it('qualifies an off-avatar business (podóloga) instead of ruling it out', async () => {
    const agent = buildFrontDeskAgent();
    const res = await agent.generate(
      [
        {
          role: 'user',
          content:
            'Hola, vi su anuncio. Yo tengo una clínica de podología, no es med spa — ¿esto me funcionaría? Mis pacientes agendan consulta por WhatsApp.',
        },
      ],
      { requestContext: rc() },
    );

    expect(toolIds(res)).not.toContain('updateConversationStatus');
    // Refusal phrasings only — "no solo med spas" is a GOOD reply, so no med-spa branch
    // here (an earlier regex had one and failed a correct answer on it).
    expect(reply(res)).not.toMatch(/no te (lo )?(voy a |puedo )?(vender|servir)|no es para ti|no aplica|no te funcionar/);
  }, 120_000);

  // The single carve-out of the new offer, and it is a disclosure, not a door: a shop that
  // takes the order, charges and ships inside the chat is not what the system is built for
  // today. Saying so is honest; parking the conversation in standby over it is the old
  // behavior, and it is exactly what "hoy no descalificas a nadie" removed.
  it('is honest with a chat-sales business without disqualifying it', async () => {
    const agent = buildFrontDeskAgent();
    const res = await agent.generate(
      [
        {
          role: 'user',
          content:
            'Hola! Yo vendo ropa por WhatsApp, ahí mismo me hacen el pedido, me pagan y les mando el paquete. ¿Me sirve?',
        },
      ],
      { requestContext: rc() },
    );

    expect(toolIds(res)).not.toContain('updateConversationStatus');
    // Not a door in the face: the call stays available, or at minimum the turn keeps moving.
    expect(/\?/.test(reply(res)) || /llamada|leo/.test(reply(res)), `sin salida: ${res.text}`).toBe(true);
  });
});

describe.skipIf(!evalApiKey)('money — $500 alone is the half that sounds cheap', () => {
  // The number quotes fine on its own and sounds complete, which is the problem: at $500 a
  // month the offer reads as a toy unless the same message says Leo's work is free and the
  // $500 are the tools he pays for. That pairing is what makes it believable.
  it('discloses both halves the first time price comes up', async () => {
    const agent = buildFrontDeskAgent();
    const res = await agent.generate(
      [{ role: 'user', content: 'Vi el anuncio. ¿Cuánto cuesta?' }],
      { requestContext: rc() },
    );

    expect(reply(res)).toMatch(/500/);
    expect(reply(res)).toMatch(/herramienta|no cobra|sin costo|no te cobra|su trabajo|plataforma/);
  });

  it('discloses both halves even when price comes up mid-conversation', async () => {
    const agent = buildFrontDeskAgent();
    const res = await agent.generate(
      [
        { role: 'user', content: 'Hola, vi su anuncio de contestar los mensajes' },
        {
          role: 'assistant',
          content:
            'Hola, qué gusto. Somos The Bot Crew: contestamos todos los mensajes que le llegan a tu negocio por WhatsApp, Facebook e Instagram, 24/7.\n\n¿De qué es tu negocio?',
        },
        { role: 'user', content: 'Tengo un salón de eventos en Guadalajara. Si me escriben harto por WhatsApp' },
        { role: 'assistant', content: 'Perfecto. ¿Quién contesta esos mensajes hoy?' },
        { role: 'user', content: 'Cuanto cuesta?' },
      ],
      { requestContext: rc() },
    );

    expect(reply(res)).toMatch(/500/);
    expect(reply(res)).toMatch(/herramienta|no cobra|sin costo|no te cobra|su trabajo|plataforma/);
  });

  // Transcribed from a live thread (2026-08-20, 22:02) under the previous offer: asked
  // "¿cuánto cuesta?", Sara answered SEVEN things — price, what's included, no contract,
  // month to month, cancel anytime, payment methods, invoicing. The cause was structural
  // (contract/payment/invoicing lived INSIDE the "# Precio" section) and the fix survived
  // the offer change: those facts still live in their own "solo si lo preguntan" sections,
  // and the price block still ends with a scoped stop plus an explicit order to keep moving.
  it('answers the price without dumping the rest, and still moves', async () => {
    const agent = buildFrontDeskAgent();
    const res = await agent.generate(
      [
        { role: 'user', content: '¡Hola! Vi su anuncio y me interesa recibir más información.' },
        {
          role: 'assistant',
          content:
            '¡Hola! Soy Sara, de The Bot Crew. Contestamos todos los mensajes que le llegan a tu negocio por WhatsApp, Facebook e Instagram, 24/7.\n\nPara ubicarme: ¿los mensajes los contestas tú o alguien de tu equipo?',
        },
        { role: 'user', content: 'Marina, mi recepcionista' },
        {
          role: 'assistant',
          content:
            'La idea no es reemplazar a Marina, sino cubrirla cuando está ocupada o fuera de horario.\n\n¿Más o menos cuántos mensajes les llegan?',
        },
        { role: 'user', content: 'Como 30 al día' },
        // The close is SPENT here. That is the ingredient that made it stall live: the
        // model may not reuse this question, so if the price block also tells it to stop,
        // it has no move left. A history without this line does not reproduce the bug.
        {
          role: 'assistant',
          content:
            'Con ese volumen se nota rápido. En una videollamada de 20 minutos, Leo revisa tu caso y te muestra el sistema.\n\n¿Te aparto un espacio con Leo?',
        },
        { role: 'user', content: 'Cuando me va costar?' },
      ],
      { requestContext: rc() },
    );

    expect(reply(res)).toMatch(/500/);
    // The facts that were riding along uninvited.
    expect(reply(res), `info dump: ${res.text}`).not.toMatch(/factura|transferencia|tarjeta de (crédito|debito|débito)/);
    expect(reply(res), `info dump: ${res.text}`).not.toMatch(/sin contrato|plazo forzoso|mes a mes|cancela(n|r)? cuando/);
    // …and it still has to MOVE.
    expect(/\?/.test(reply(res)) || /agend|apart|horario/.test(reply(res)), `sin siguiente paso: ${res.text}`).toBe(true);
  });

  // Under the old offer the install was $15,000 waived; now there is no install charge at
  // all. A model that hedges here invents a cost the offer does not have, right at the
  // moment of decision.
  it('says there is no install charge instead of deferring to the call', async () => {
    const agent = buildFrontDeskAgent();
    const res = await agent.generate(
      [{ role: 'user', content: '¿Y cuánto sale la instalación? ¿Cuánto tengo que pagar de entrada?' }],
      { requestContext: rc() },
    );

    expect(reply(res)).toMatch(/no hay (costo|cargo)|sin costo|gratis|no tiene costo|no cobra|solo (son |es )?\$?500|únicamente/);
  });

  // The tools are the whole reason the $500 exist, so "do I pay for a CRM on top?" has to
  // land as a flat no. Hedging re-creates the cost the offer was built to absorb.
  it('answers that the tools are included, without inventing one to pay for', async () => {
    const agent = buildFrontDeskAgent();
    const res = await agent.generate(
      [{ role: 'user', content: '¿Y tengo que pagar alguna herramienta o suscripción aparte? tipo un CRM' }],
      { requestContext: rc() },
    );

    expect(reply(res)).toMatch(/inclui|incluye|no (tienes|hay) que pagar|sin costo adicional|dentro de los/);
  });
});

describe.skipIf(!evalApiKey)('what is no longer sold', () => {
  // THE case of this rewrite. Lead generation left the offer, but it is what every AI
  // agency sells and what this very prompt sold three weeks ago, so agreeing to it is the
  // model's most available mistake — and the most expensive, because the client would find
  // out on the call at best and after paying at worst.
  it('does not promise ads or lead generation', async () => {
    const agent = buildFrontDeskAgent();
    const res = await agent.generate(
      [{ role: 'user', content: 'Y ustedes también me manejan los anuncios y me consiguen clientes nuevos?' }],
      { requestContext: rc() },
    );

    // The negation has to be ATTACHED to what is being refused. A bare /\bno\b/ passes on
    // almost any Spanish reply — it was the first version of this assertion and it made the
    // case unfalsifiable — so the refusal must land within a few words of the ads/clients it
    // refuses ("no manejamos anuncios", "no en manejar anuncios ni conseguir clientes").
    expect(reply(res), `sin negación: ${res.text}`).toMatch(
      /\bno\b[^.!?]{0,20}(manej|consegu|genera|corre|anuncios|clientes nuevos)/,
    );
    // …and it must not claim it anyway.
    expect(reply(res), `promete leads: ${res.text}`).not.toMatch(
      /(sí|si|claro),? (también )?(te )?(manejamos|manejo|corremos|hacemos)|te (consigo|conseguimos|traemos) clientes|generación de leads incluid/,
    );
  });

  it('redirects to what the system actually does', async () => {
    const agent = buildFrontDeskAgent();
    const res = await agent.generate(
      [{ role: 'user', content: 'necesito más clientes, me pueden ayudar con eso?' }],
      { requestContext: rc() },
    );

    expect(reply(res)).toMatch(/mensajes?|contest|whatsapp/);
  });
});

describe.skipIf(!evalApiKey)('the call with Leo — offered when it IS the answer', () => {
  // A message cannot answer "I don't know you". Meeting the person can.
  it('offers the call when the lead doubts that Leo is a real person', async () => {
    const agent = buildFrontDeskAgent();
    const res = await agent.generate(
      [{ role: 'user', content: 'oye y Leo es real? como se que no me estan estafando' }],
      { requestContext: rc() },
    );

    expect(reply(res)).toMatch(/llamada|videollamada|hablar con leo|20 minutos/);
  });

  it('answers the first doubt without pitching a call', async () => {
    const agent = buildFrontDeskAgent();
    const res = await agent.generate(
      [{ role: 'user', content: '¿Quién contesta los mensajes, una persona o un bot?' }],
      { requestContext: rc() },
    );

    expect(reply(res)).not.toMatch(/agendamos una llamada|te agendo una llamada|llamada con leo/);
  });

  it('helps without selling the offer back to someone who is already a client', async () => {
    const agent = buildFrontDeskAgent();
    const res = await agent.generate(
      [{ role: 'user', content: 'Oye, ya me está contestando el asistente pero quiero cambiar el horario que ofrece' }],
      { requestContext: rc() },
    );

    expect(reply(res)).not.toMatch(/\$?500|lugares|precio congelado/);
  });
});

// A capability we do not have TODAY is not the same thing as a fact missing from the
// config, and reading them as one cost a real lead (2026-09-08, Leo's own test thread):
// a wedding photographer asked whether the assistant could quote each event, got
// "cotizaciones formales o documentos personalizados no están contemplados", and the
// next turn parked the thread on `flagPendingInfo` — a queue nobody owed him an answer
// from. Both moves are wrong: the system IS built per business, so the honest answer is
// "sí se puede armar", and the place that gets defined is the call.
//
// Measured on `gpt-5.6-luna` (the model that produced the incident), 2026-09-08 — this one
// DISCRIMINATES, unlike most of the file: 3/3 green with the houseRules section in the
// fixture, and 6/6 RED (both cases, three runs) with it removed and the old blanket line
// restored. Every red run failed the same way the incident did — "déjame lo confirmo con el
// equipo" plus a flagPendingInfo call — so the assertion that carries the weight is the
// pending-info one, not the refusal wording.
describe.skipIf(!evalApiKey)('a capability that does not exist YET → the call, not a refusal', () => {
  const asks = (text: string) => async () => {
    const agent = buildFrontDeskAgent();
    const res = await agent.generate([{ role: 'user', content: text }], { requestContext: rc() });

    // 1. It must not close the door.
    expect(reply(res), `lo niega: ${res.text}`).not.toMatch(
      /no (est[aá]n? |es )?(contemplad|dispon|inclu|posible)|no (lo |se )?(puede|podemos|hacemos|manejamos) (eso|cotiza|documento)|por ahora no|todav[ií]a no/,
    );
    // 2. It must not park it as an owed fact — this is not a config gap.
    expect(toolIds(res), `lo marca como pendiente: ${res.text}`).not.toContain('flagPendingInfo');
    expect(reply(res), `dice que lo confirma: ${res.text}`).not.toMatch(/confirm[oa]\w* con el equipo|te aviso en cuanto/);
    // 3. It must point at the call, which is where it actually gets defined.
    expect(reply(res), `no ofrece la llamada: ${res.text}`).toMatch(/llamada|videollamada|con leo|20 minutos/);
  };

  it('quoting each job automatically', asks(
    'Quisiera poder mandar cotizaciones inmediatamente, calculando cada evento por separado. ¿Es algo que hagas?',
  ));

  it('a document built from each customer’s data', asks(
    'Se puede que arme documentos personalizados con los datos de cada cliente?',
  ));
});
