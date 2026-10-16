/**
 * Dr. Heriberto Valdivia — bótox: se vende la valoración, no el tratamiento (houseRules "# Bótox").
 *
 * Un solo flujo para el bótox, venga del anuncio que venga: al "¿cuánto cuesta?" se contesta el
 * "desde $2,000" y de qué depende, nunca el precio de una zona; antes de los horarios, HASTA tres
 * preguntas (qué mejorar, si ya se lo aplicó, para cuándo), saltando las que ya están contestadas.
 * Quien llega sabiendo lo que quiere recibe horarios en ese turno.
 *
 * El lado rojo (`BXV_RED=1`) es la config anterior: la lista por zona en offering / services / FAQ
 * y sin la sección "# Bótox" (ni el puntero en "El precio es el momento").
 *
 * MEDIDO 2026-10-15 (gpt-6-luna, high, 3 corridas por lado):
 *   los tres casos de precio (frío, insiste con la frente, antifaz) — rojo 0/3 · verde 3/3.
 *   los dos de agendar (caliente; frío con las tres respuestas) — rojo 1/3 y 3/3 · verde 3/3:
 *   no prueban la regla, son la guarda de que las preguntas no frenan a quien ya está listo.
 *
 * MEDIDO 2026-10-16, la excepción del primer mensaje (el texto del anuncio no cuenta como pedir
 * agendar): "quiero mi consulta gratis de bótox" solo — sin la excepción 1/6 (fue a horarios) ·
 * con ella 5/5. Quien no contesta la pregunta se distingue de quien se frenó ante los horarios.
 *
 * Live-only (needs an API key); `pnpm eval`, excluded from the CI gate.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../db/queries.js');

const getAvailability = vi.fn();
vi.mock('../../../ghl/client.js', () => ({
  GhlClient: vi.fn(() => ({
    getAvailability,
    getContactAppointments: vi.fn().mockResolvedValue([]),
    addContactTags: vi.fn().mockResolvedValue(undefined),
  })),
}));

import * as q from '../../../db/queries.js';
import { buildFrontDeskAgent } from '../agent.js';
import { slotLabel } from '../tools/slot-label.js';
import { buildAgentRequestContext } from '../../../core/runtime-context.js';
import { toModelMessages } from '../../../core/model-messages.js';
import type { ConversationMessage, TenantContext, TurnContext } from '../../../core/types.js';
import { heribertoTenant, HERIBERTO_PERSONA, HERIBERTO_SERVICES, HERIBERTO_FAQ } from './fixtures.js';
import { evalApiKey, evalModel, evalProvider } from './eval-model.js';

const TZ = 'America/Chihuahua';
const RED = process.env.BXV_RED === '1';

const swap = (s: string, from: string, to: string): string => {
  if (!s.includes(from)) throw new Error(`fixture drifted: ${from.slice(0, 60)}`);
  return s.replace(from, () => to);
};

/** La config anterior: precio por zona en todos lados, sin la sección "# Bótox". */
const ZONE_LIST = 'frente $2,500, entrecejo $2,000, patas de gallo $2,000, maseteros $3,500; full face (frente, entrecejo y patas de gallo) $6,000';
const redConfig = (): TenantContext['config'] => {
  const houseRules = HERIBERTO_PERSONA.houseRules.slice(0, HERIBERTO_PERSONA.houseRules.indexOf('\n\n# Bótox:'));
  let offering = swap(
    HERIBERTO_PERSONA.offering,
    '- Botox — desde $2,000. El valor final depende de la zona, de cuántas unidades se necesitan y del resultado que se busca: el precio exacto lo da el Dr. Valdivia en la valoración (ver "# Bótox" en tus reglas).',
    `- Botox por zona: ${ZONE_LIST}.`,
  );
  offering = swap(offering, 'con ese mismo "desde".', 'con ese mismo precio.');
  const qualificationNotes = swap(
    HERIBERTO_PERSONA.qualificationNotes,
    ' Bótox es la excepción: su precio no va con horarios todavía, sigue la sección "# Bótox" de tus reglas.',
    '',
  );
  return {
    ...heribertoTenant.config,
    promptOverrides: { ...HERIBERTO_PERSONA, houseRules, offering, qualificationNotes },
    services: HERIBERTO_SERVICES.map((s) => (s.name === 'Botox' ? { ...s, description: `Por zona: ${ZONE_LIST}.` } : s)),
    faq: HERIBERTO_FAQ.map((f) =>
      /^¿Cuánto cuesta el bótox\?/.test(f.q)
        ? { ...f, a: 'El bótox se cobra por zona: frente, entrecejo, patas de gallo o maseteros; también hay full face (frente, entrecejo y patas de gallo). Cada zona tiene su precio en la lista de tratamientos.' }
        : /zona del antifaz/.test(f.q)
          ? { ...f, a: 'La zona del antifaz es el tercio superior del rostro completo: frente, entrecejo y patas de gallo, las tres juntas. Es lo mismo que el full face, así que lleva ese precio.' }
          : f,
    ),
  };
};

const tenant: TenantContext = RED ? { ...heribertoTenant, config: redConfig() } : heribertoTenant;

const turn: TurnContext = {
  ghlConversationId: 'conv_eval_botox_valoracion',
  ghlContactId: 'contact_eval_botox_valoracion',
  contactPhone: '+526141234567',
  channel: 'whatsapp',
};

const nextWeekday = (): string => {
  const d = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
  while ([0, 6].includes(d.getUTCDay())) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};
const DAY = nextWeekday();
const SLOTS = [`${DAY}T16:15:00-06:00`, `${DAY}T18:15:00-06:00`].map((start) => ({ start, end: start }));
const LABELS = SLOTS.map((s) => slotLabel(s.start, TZ, TZ));

const usesRealLabel = (text: string): boolean =>
  LABELS.some((label) => {
    const weekday = label.split(',')[0]!.toLowerCase();
    const time = label.match(/\d{1,2}:\d{2}/)?.[0] ?? '';
    return !!time && text.includes(weekday) && text.includes(time);
  });

type ToolCallChunkLike = { payload: { toolName: string } };
const toolIds = (res: { toolCalls?: ToolCallChunkLike[] }): string[] => (res.toolCalls ?? []).map((c) => c.payload.toolName);

const at = (iso: string): string => `${iso}:00-06:00`;
const lead = (content: string, t: string): ConversationMessage => ({ direction: 'inbound', senderType: 'lead', content, sentAt: at(t) });
const bot = (content: string, t: string): ConversationMessage => ({ direction: 'outbound', senderType: 'bot', content, sentAt: at(t) });

const generate = async (history: ConversationMessage[]) => {
  const res = await buildFrontDeskAgent().generate(toModelMessages(history), {
    requestContext: buildAgentRequestContext({ tenant, turn, provider: evalProvider, model: evalModel, llmApiKey: evalApiKey }),
  });
  if (process.env.EVAL_DEBUG) console.log(`[eval botox-valoracion${RED ? ' RED' : ''}]`, res.text);
  return res;
};

/**
 * Los precios de zona y de combinación que la config anterior daba. Entrecejo y patas de gallo
 * costaban $2,000, el mismo número que el "desde", así que no se distinguen y no se buscan.
 */
const ZONE_PRICE = /2,?500|6,?000|3,?500|7,?500|8,?000/;
const DESDE = /desde \$?2,?000|parte (?:de|en|desde) \$?2,?000|a partir de \$?2,?000/;
const ASKS_WHAT_TO_IMPROVE = /mejorar|suavizar|qu[eé] (?:zona|l[ií]neas)|te preocupa|te gustar[ií]a/;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(q.logBotEvent).mockResolvedValue(undefined);
  vi.mocked(q.getActiveDemoSession).mockResolvedValue(null);
  getAvailability.mockResolvedValue(SLOTS);
});

describe.skipIf(!evalApiKey)('Dr. Heriberto Valdivia — bótox: se vende la valoración', () => {
  it('frío, "¿cuánto cuesta el bótox?" → el "desde $2,000" y qué le gustaría mejorar, sin zonas ni horarios', async () => {
    const res = await generate([lead('Hola, ¿cuánto cuesta el bótox?', '2026-10-15T10:00')]);
    const text = res.text.toLowerCase();
    expect(text, text).toMatch(DESDE);
    expect(text, text).not.toMatch(ZONE_PRICE);
    expect(text, text).toMatch(ASKS_WHAT_TO_IMPROVE);
    expect(toolIds(res), text).not.toContain('getAvailability');
  }, 120_000);

  it('insiste con una zona → sigue en el "desde", nunca el precio de la frente', async () => {
    const res = await generate([
      lead('Hola, ¿cuánto cuesta el bótox?', '2026-10-15T10:00'),
      bot('¡Hola! Soy Sofía, del consultorio del Dr. Heriberto Valdivia 😊 El bótox parte desde $2,000; el valor final depende de la zona y de cuántas unidades necesitas, por eso tu precio exacto te lo da el doctor en tu valoración, que es sin costo.', '2026-10-15T10:00'),
      bot('Para orientarte mejor, ¿qué te gustaría suavizar?', '2026-10-15T10:00'),
      lead('Nomás dime cuánto cuesta la frente', '2026-10-15T10:03'),
    ]);
    const text = res.text.toLowerCase();
    expect(text, text).not.toMatch(ZONE_PRICE);
    expect(text, text).toMatch(DESDE);
  }, 120_000);

  it('"¿cuánto cuesta el antifaz?" → el "desde", no el precio del full face', async () => {
    const res = await generate([lead('Buenas tardes, cuánto cuesta el bótox de antifaz?', '2026-10-15T10:00')]);
    const text = res.text.toLowerCase();
    expect(text, text).not.toMatch(ZONE_PRICE);
    expect(text, text).toMatch(DESDE);
  }, 120_000);

  it('retargeting, solo el texto del anuncio ("quiero mi consulta gratis de bótox") → la pregunta 1, todavía sin horarios', async () => {
    const res = await generate([lead('Hola, quiero mi consulta gratis de bótox', '2026-10-15T10:00')]);
    const text = res.text.toLowerCase();
    expect(toolIds(res), text).not.toContain('getAvailability');
    expect(text, text).toMatch(ASKS_WHAT_TO_IMPROVE);
    expect(text, text).not.toMatch(ZONE_PRICE);
  }, 120_000);

  it('caliente, ya trae zona, antecedente y fecha → horarios reales en ese turno', async () => {
    const res = await generate([
      lead('Hola! Quiero agendar para bótox en frente y entrecejo. Ya me lo he puesto antes, lo quiero para una boda a fines de noviembre', '2026-10-15T10:00'),
    ]);
    const text = res.text.toLowerCase();
    expect(toolIds(res), text).toContain('getAvailability');
    expect(usesRealLabel(text), text).toBe(true);
    expect(text, text).not.toMatch(ZONE_PRICE);
  }, 120_000);

  it('frío que ya contestó las tres preguntas → horarios reales, sin cuarta pregunta', async () => {
    const res = await generate([
      lead('Precio del bótox', '2026-10-15T10:00'),
      bot('¡Hola! Soy Sofía, del consultorio del Dr. Heriberto Valdivia 😊 El bótox parte desde $2,000; el valor final depende de la zona y de cuántas unidades necesitas, por eso tu precio exacto te lo da el doctor en tu valoración, que es sin costo.', '2026-10-15T10:00'),
      bot('Para orientarte mejor, ¿qué te gustaría suavizar?', '2026-10-15T10:00'),
      lead('Las patas de gallo', '2026-10-15T10:04'),
      bot('Perfecto, es de las zonas que mejor responden 😊 ¿Te has aplicado bótox antes? Así el doctor sabe de dónde partir.', '2026-10-15T10:04'),
      lead('No, sería mi primera vez', '2026-10-15T10:06'),
      bot('Muy bien, es de lo más común empezar por ahí. ¿Tienes alguna fecha o evento en mente? Así vemos que llegues con el resultado ya asentado.', '2026-10-15T10:06'),
      lead('No, nada en especial', '2026-10-15T10:09'),
    ]);
    const text = res.text.toLowerCase();
    expect(toolIds(res), text).toContain('getAvailability');
    expect(usesRealLabel(text), text).toBe(true);
    expect(text, text).not.toMatch(ZONE_PRICE);
  }, 120_000);
});
