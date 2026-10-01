/**
 * Golden cases for The Bot Crew's own funnel — the clinic pilot (2026-09-30).
 *
 * The offer: Leo installs the whole appointment system for a medical-aesthetics clinic —
 * the offer for its main treatment, Meta ads that land on WhatsApp, the assistant that
 * answers and books, follow-up and reminders. His service is not charged; the clinic pays
 * the tools ($500 MXN/mes) and the ad spend straight to Meta (~$200 MXN/día). The ad
 * promises "te digo si tu clínica califica", so the flow QUALIFIES, on three conditions:
 * it does medical aesthetics (not a beauty salon, not laser-only), it can fund the ad
 * spend, and whoever decides is on the call.
 *
 *   · THE FORM IS READ, NOT RE-ASKED. Most leads arrive with a Meta lead form already in
 *     their first message; asking again what they just answered is the tell of a bot.
 *
 *   · A NO IS SAID, AND THE THREAD IS PARKED WITH ITS REASON. A salon or a laser-only shop
 *     is told warmly and lands in standby with a reason (lead_disqualified, 0042) — no call.
 *
 *   · DOUBT IS NOT A NO. Hesitating on the ad spend gets an explanation, not a standby.
 *
 *   · THE PRICE IS THREE FACTS. Leo's service is free, the tools are $500, the ad spend is
 *     the clinic's — and "gratis" alone is never said, because two of the three cost money.
 *
 * The tools are mocked inert: these cases assert on which tools the model REACHES FOR, so
 * nothing may touch the real DB or GHL.
 *
 * What each case is worth (§6c), measured on `gpt-5.6-luna`, 2026-09-30, 3 runs per side,
 * red side = the "# Quién califica" section deleted from the fixture:
 *   · laser-only → standby: DISCRIMINATES — red 0/3, green 3/3.
 *   · meets all three → "sí califica" + the call: DISCRIMINATES — red 0/3; and before the
 *     "med spa ya la cumple" line it failed 0/5 WITH the section (the model read "med spa"
 *     as an ambiguous "spa" and asked for treatments); with the line, 5/5 + 3/3.
 *   · not the decision-maker → asks if who decides can join: DISCRIMINATES — red 1/3, green 3/3.
 *   · price before qualification → price in that same message: was 2/5 before "no lo
 *     condiciones a la calificación" (the model withheld it to qualify first), 5/5 + 3/3 after.
 *   · Every other case is a GUARD — green on both sides (the salon is ruled out from the
 *     offering's "Para quién es" alone, the ad spend is asked from the price block alone).
 *     They hold the behavior we have; they do not prove the wording produces it.
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

// Verbatim first message of an Instagram lead form (2026-09-30).
const FORM_SPA = `Hello! I filled out your form and would like to know more about your business.
Full name: Antonio Salceda
WhatsApp number: +526618505089
¿Cuál es tu rol en el negocio?: Soy el dueño / la dueña
¿Cuántas personas nuevas te escriben por WhatsApp a la semana?: Menos de 10
¿Quién contesta el WhatsApp del negocio hoy?: Yo, desde mi celular
¿Qué tipo de negocio tienes?: Spa
De los mensajes que llegan a WA, ¿cuántos crees que se queden sin contestar o los contestas tarde?: 3`;

const form = (tipo: string, rol = 'Soy el dueño / la dueña') => `Hello! I filled out your form and would like to know more about your business.
Full name: Laura Méndez
WhatsApp number: +526641112233
¿Cuál es tu rol en el negocio?: ${rol}
¿Cuántas personas nuevas te escriben por WhatsApp a la semana?: Entre 10 y 30
¿Quién contesta el WhatsApp del negocio hoy?: Mi recepcionista
¿Qué tipo de negocio tienes?: ${tipo}
De los mensajes que llegan a WA, ¿cuántos crees que se queden sin contestar o los contestas tarde?: Algunos`;

const PAUTA = /pauta|anuncios|invertir|inversión|\$?200/;

describe.skipIf(!evalApiKey)('qualification — the ad promised "te digo si tu clínica califica"', () => {
  // "Spa" alone does not say whether it does medical aesthetics, so the first move is to
  // ask — never to re-ask the form, never to conclude, never to price or book.
  it('reads the form and asks what is missing, instead of re-asking it', async () => {
    const agent = buildFrontDeskAgent();
    const res = await agent.generate([{ role: 'user', content: FORM_SPA }], { requestContext: rc() });

    expect(res.text).toContain('?');
    expect(toolIds(res)).not.toContain('updateConversationStatus');
    expect(toolIds(res)).not.toContain('getAvailability');
    expect(reply(res), `re-pregunta el formulario: ${res.text}`).not.toMatch(
      /qué tipo de negocio|cuántos mensajes (te |les )?llegan|quién (los )?contesta|cuál es tu rol/,
    );
    expect(reply(res), `suelta el precio: ${res.text}`).not.toMatch(/\$?500/);
  }, 120_000);

  it('asks about the ad spend once the business is clearly medical aesthetics', async () => {
    const agent = buildFrontDeskAgent();
    const res = await agent.generate(
      [{ role: 'user', content: form('Clínica de medicina estética (bótox, rellenos, bioestimuladores)') }],
      { requestContext: rc() },
    );

    expect(reply(res), `no pregunta la pauta: ${res.text}`).toMatch(PAUTA);
    expect(toolIds(res)).not.toContain('updateConversationStatus');
  }, 120_000);

  type Turn = { role: 'user'; content: string } | { role: 'assistant'; content: string };
  const disqualifies = (history: Turn[]) => async () => {
    const agent = buildFrontDeskAgent();
    const res = await agent.generate(history, { requestContext: rc() });

    expect(toolIds(res), `no la descarta: ${res.text}`).toContain('updateConversationStatus');
    expect(toolIds(res)).not.toContain('getAvailability');
    expect(toolIds(res)).not.toContain('bookAppointment');
  };

  it('rules out a beauty salon, warmly, and parks it with a reason', disqualifies([
    { role: 'user', content: form('Salón de belleza') },
    {
      role: 'assistant',
      content: 'Hola Laura, soy Sara, asistente de Leo, de The Bot Crew. Gracias por llenar el formulario.\n\n¿Qué servicios o tratamientos ofrecen en el salón?',
    },
    { role: 'user', content: 'Cortes, tinte, uñas y pestañas. Y sí puedo invertir en anuncios.' },
  ]), 120_000);

  it('rules out a laser-only business', disqualifies([
    { role: 'user', content: form('Depilación láser') },
    {
      role: 'assistant',
      content: 'Hola Laura, soy Sara, asistente de Leo, de The Bot Crew. Gracias por llenar el formulario.\n\n¿Qué tratamientos ofrecen además de la depilación láser?',
    },
    { role: 'user', content: 'Solo depilación láser, es lo único que hacemos. La pauta sí la puedo pagar.' },
  ]), 120_000);

  it('tells a clinic that meets all three that it qualifies, and offers the call', async () => {
    const agent = buildFrontDeskAgent();
    const res = await agent.generate(
      [
        { role: 'user', content: form('Med spa') },
        {
          role: 'assistant',
          content:
            'Hola Laura, soy Sara, asistente de Leo, de The Bot Crew. Gracias por llenar el formulario.\n\nPara los anuncios, el programa necesita una inversión en pauta de unos $200 MXN diarios, pagados directo a Meta. ¿Es algo que pueden invertir?',
        },
        { role: 'user', content: 'Sí, sin problema' },
      ],
      { requestContext: rc() },
    );

    expect(reply(res), `no le dice que califica: ${res.text}`).toMatch(/califica/);
    expect(reply(res), `no ofrece la llamada: ${res.text}`).toMatch(/llamada|videollamada|con leo|20 minutos|horario/);
    expect(toolIds(res)).not.toContain('updateConversationStatus');
  }, 120_000);

  it('asks whether the decision-maker can join when the lead does not decide', async () => {
    const agent = buildFrontDeskAgent();
    const res = await agent.generate(
      [
        { role: 'user', content: form('Clínica de medicina estética', 'Trabajo ahí, pero no tomo las decisiones') },
        {
          role: 'assistant',
          content:
            'Hola Laura, soy Sara, asistente de Leo, de The Bot Crew. Gracias por llenar el formulario.\n\nPara los anuncios, el programa necesita una inversión en pauta de unos $200 MXN diarios, pagados directo a Meta. ¿Es algo que la clínica puede invertir?',
        },
        { role: 'user', content: 'Creo que sí, la doctora ya gasta en anuncios' },
      ],
      { requestContext: rc() },
    );

    expect(reply(res), `no pregunta por quien decide: ${res.text}`).toMatch(
      /(unir|conectar|estar|participar|sumar)[^.?!]{0,60}(llamada|videollamada)|quien (toma|tome) (la|las) decisi|la doctora/,
    );
    expect(toolIds(res)).not.toContain('bookAppointment');
  }, 120_000);

  it('does not rule out a clinic that only hesitates on the ad spend', async () => {
    const agent = buildFrontDeskAgent();
    const res = await agent.generate(
      [
        { role: 'user', content: form('Clínica de medicina estética') },
        {
          role: 'assistant',
          content:
            'Hola Laura, soy Sara, asistente de Leo, de The Bot Crew. Gracias por llenar el formulario.\n\nPara los anuncios, el programa necesita una inversión en pauta de unos $200 MXN diarios, pagados directo a Meta. ¿Es algo que pueden invertir?',
        },
        { role: 'user', content: 'Uy, está algo alto. ¿No puede ser menos?' },
      ],
      { requestContext: rc() },
    );

    expect(toolIds(res), `la descarta por dudar: ${res.text}`).not.toContain('updateConversationStatus');
  }, 120_000);
});

describe.skipIf(!evalApiKey)('money — three facts, and never "gratis" alone', () => {
  // Negative lookbehind: "no es gratis" is the correct correction, a bare "gratis" is not.
  const BARE_GRATIS = /(?<!no (es )?)\bgratis\b/;

  it('names the tools AND the ad spend the first time price comes up', async () => {
    const agent = buildFrontDeskAgent();
    const res = await agent.generate([{ role: 'user', content: 'Vi el anuncio. ¿Cuánto cuesta?' }], { requestContext: rc() });

    expect(reply(res)).toMatch(/500/);
    expect(reply(res), `sin la pauta: ${res.text}`).toMatch(/pauta|anuncios|meta/);
    expect(reply(res), `dice gratis: ${res.text}`).not.toMatch(BARE_GRATIS);
  }, 120_000);

  it('corrects "¿entonces es gratis?" instead of agreeing', async () => {
    const agent = buildFrontDeskAgent();
    const res = await agent.generate(
      [
        { role: 'user', content: '¿Cuánto cobran?' },
        {
          role: 'assistant',
          content:
            'Leo no cobra su servicio. La clínica paga las herramientas, $500 MXN al mes, y la pauta de los anuncios directo a Meta.\n\n¿Qué tipo de tratamientos ofrecen?',
        },
        { role: 'user', content: 'O sea que es gratis?' },
      ],
      { requestContext: rc() },
    );

    expect(reply(res), `no corrige: ${res.text}`).toMatch(/herramientas|pauta|500/);
    expect(reply(res), `confirma gratis: ${res.text}`).not.toMatch(/^(sí|si|exacto|así es)\b/);
  }, 120_000);

  // Transcribed from a live thread (2026-08-20, 22:02) under an earlier offer: asked
  // "¿cuánto cuesta?", Sara answered SEVEN things — price, what's included, no contract,
  // month to month, cancel anytime, payment methods, invoicing. Contract/payment/invoicing
  // still live in their own "solo si lo preguntan" sections, and the price block still ends
  // with a scoped stop plus an explicit order to keep moving.
  it('answers the price without dumping the rest, and still moves', async () => {
    const agent = buildFrontDeskAgent();
    const res = await agent.generate(
      [
        { role: 'user', content: form('Clínica de medicina estética') },
        {
          role: 'assistant',
          content:
            'Hola Laura, soy Sara, asistente de Leo, de The Bot Crew. Gracias por llenar el formulario.\n\nPara los anuncios, el programa necesita una inversión en pauta de unos $200 MXN diarios, pagados directo a Meta. ¿Es algo que pueden invertir?',
        },
        { role: 'user', content: 'Sí' },
        {
          role: 'assistant',
          content:
            'Perfecto, tu clínica sí califica. Lo que sigue es una videollamada de 20 minutos con Leo para revisar tu caso.\n\n¿Te aparto un espacio con Leo?',
        },
        { role: 'user', content: 'Cuanto me va costar?' },
      ],
      { requestContext: rc() },
    );

    expect(reply(res)).toMatch(/500/);
    expect(reply(res), `info dump: ${res.text}`).not.toMatch(/factura|transferencia|tarjeta de (crédito|debito|débito)/);
    expect(reply(res), `info dump: ${res.text}`).not.toMatch(/plazo forzoso|cancela(n|r)? cuando/);
    expect(/\?/.test(reply(res)) || /agend|apart|horario/.test(reply(res)), `sin siguiente paso: ${res.text}`).toBe(true);
  }, 120_000);
});

describe.skipIf(!evalApiKey)('ads and results', () => {
  // The single likeliest leftover of the previous offer, which said "hoy no" to exactly this.
  it('says yes, Leo runs the ads, and the spend is the clinic\'s', async () => {
    const agent = buildFrontDeskAgent();
    const res = await agent.generate(
      [{ role: 'user', content: '¿Y ustedes me manejan los anuncios o eso lo tengo que hacer yo?' }],
      { requestContext: rc() },
    );

    expect(reply(res), `niega los anuncios: ${res.text}`).not.toMatch(/\bno\b[^.!?]{0,20}(manej|corre|hacemos) (los |tus )?anuncios/);
    expect(reply(res), `no dice quién paga la pauta: ${res.text}`).toMatch(/pauta|inversión|meta/);
  }, 120_000);

  // The pilot case is a reference, not a forecast for this clinic.
  it('does not turn the reference case into a guarantee', async () => {
    const agent = buildFrontDeskAgent();
    const res = await agent.generate(
      [{ role: 'user', content: '¿Cuántas citas me vas a conseguir al mes?' }],
      { requestContext: rc() },
    );

    expect(reply(res), `promete: ${res.text}`).not.toMatch(
      /te (garantizo|garantizamos|aseguro|aseguramos)|vas a tener \d+|(tendrás|tendrías) \d+ citas/,
    );
  }, 120_000);
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
