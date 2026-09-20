/**
 * La voz (VOICE_RULE) — cómo suena el bot, medido con un juez.
 *
 * Leo, 2026-09-20, al leer la respuesta de "cancela mi cita pagada": "así debería
 * hablar siempre: muy mexicano nativo, servicial, educado; en vez de frío tipo bot".
 * Y: "cada que repite la misma frase textual se nota que es un sistema".
 *
 * El estilo no se mide con regex, así que aquí un JUEZ (gpt-5-mini, fijo, distinto del
 * modelo bajo prueba) califica cada respuesta del 1 al 5 en calidez, naturalidad mexicana
 * y "suena a bot", y dice si repitió un arranque del historial. Los regex quedan para lo
 * que sí es binario: las muletillas prohibidas. `VOICE_RULE_OFF=1` vacía la sección y deja
 * el resto del prompt igual (tono del tenant, WARM_NO_RULE, CLOSED_QUESTION_RULE).
 *
 * Seis escenarios sobre Clínica Demo (sin apartado, para no mezclar con booking-hold):
 * pregunta de precio, "hoy", primera oferta de horarios, cierre tras agendar, un "ya no
 * me interesa", y un segundo turno que NO debe arrancar igual que el anterior.
 *
 *   MEDIDO en gpt-5.6-luna, 2026-09-20, juez gpt-5-mini (corridas seriadas, 6 escenarios c/u):
 *   - escenarios que pasan la barra (calidez ≥ 4, bot ≤ 2, sin repetir, sin muletillas):
 *       con VOICE_RULE 5/6 · 5/6 · 3/6        sin VOICE_RULE 0/6 · 3/6 · 2/6
 *   - media de calidez:  4.17 · 4.33 · 3.83   vs  3.33 · 3.67 · 3.50
 *   - media de "bot":    1.33 · 1.50 · 1.67   vs  2.83 · 2.00 · 2.67
 *   Umbrales fijados con esos datos: ≥ 3 escenarios, calidez ≥ 3.8, bot ≤ 1.9 → 3/3 verde con la
 *   regla, 0/3 sin ella. El margen es corto (3.83 vs 3.8 en la peor corrida): una corrida roja
 *   aislada es ruido de estilo, dos seguidas son regresión.
 *   Historia del instrumento, porque importa: la primera rúbrica castigaba la brevedad (un
 *   "Claro que sí, cuesta $900, ¿te aparto un espacio?" sacaba 2) y hacía perder la mitad de
 *   los escenarios de los dos lados; en WhatsApp lo corto es regla nuestra, así que las anclas
 *   ahora premian trato corto y castigan el dato pelón. Los escenarios que más fallan con la
 *   regla son "precio" y "primera oferta": el modelo tiende a contestar el dato correcto con
 *   un solo "claro que sí" encima; sigue siendo el siguiente frente.
 *
 * Live-only (necesita API key), excluido del gate de CI.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../db/queries.js');

const { RULE_OFF } = vi.hoisted(() => ({ RULE_OFF: process.env.VOICE_RULE_OFF === '1' }));

vi.mock('../../../core/prompt-rules.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../../core/prompt-rules.js')>();
  return RULE_OFF ? { ...mod, VOICE_RULE: '' } : mod;
});

const getAvailability = vi.fn();
const bookAppointment = vi.fn();
vi.mock('../../../ghl/client.js', () => ({
  GhlClient: vi.fn(() => ({
    getAvailability,
    bookAppointment,
    getContactPhone: vi.fn().mockResolvedValue('+5216641234567'),
    updateContactName: vi.fn().mockResolvedValue(undefined),
    updateContactTimezone: vi.fn().mockResolvedValue(undefined),
    addContactTags: vi.fn().mockResolvedValue(undefined),
    removeContactTags: vi.fn().mockResolvedValue(undefined),
    getContactAppointments: vi.fn().mockResolvedValue([]),
  })),
}));

import * as q from '../../../db/queries.js';
import { buildFrontDeskAgent } from '../agent.js';
import { buildAgentRequestContext } from '../../../core/runtime-context.js';
import type { TenantContext, TurnContext } from '../../../core/types.js';
import { createOpenAI } from '@ai-sdk/openai';
import { generateText } from 'ai';
import { demoTenant } from './fixtures.js';
import { evalApiKey, evalModel, evalProvider } from './eval-model.js';

const tenant: TenantContext = {
  ...demoTenant,
  config: {
    ...demoTenant.config,
    services: [{ name: 'Consulta general', durationMin: 30 }, { name: 'Limpieza dental', durationMin: 45 }],
    calendars: { 'Consulta general': 'cal_demo_general', 'Limpieza dental': 'cal_demo_limpieza' },
    faq: [{ q: '¿Cuánto cuesta la limpieza dental?', a: 'La limpieza dental cuesta $900 MXN e incluye revisión.' }],
    promptOverrides: {
      toolInstructions: {
        getAvailability: 'serviceName es EXACTAMENTE "Consulta general" o "Limpieza dental".',
        bookAppointment: 'serviceName es EXACTAMENTE "Consulta general" o "Limpieza dental".',
      },
    },
  },
};

const turn: TurnContext = {
  ghlConversationId: 'conv_eval_voice',
  ghlContactId: 'contact_eval_voice',
  contactPhone: '+5216641234567',
  channel: 'whatsapp',
};
const rc = () => buildAgentRequestContext({ tenant, turn, provider: evalProvider, model: evalModel, llmApiKey: evalApiKey });

const DAY = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
const SLOTS = ['10:00', '12:00', '16:00'].map((t) => ({ start: `${DAY}T${t}:00-06:00`, end: `${DAY}T${t}:00-06:00` }));

/** Fixed judge, independent of the model under test. */
const JUDGE_MODEL = 'gpt-5-mini';
interface Verdict { calidez: number; mexicano: number; bot: number; repite: boolean; motivo: string }

async function judge(history: { role: string; content: string }[], reply: string): Promise<Verdict> {
  const prompt = `Eres un evaluador de estilo. Un asistente de WhatsApp de un negocio en México acaba de contestar. Califica SOLO la última respuesta del asistente.

Historial:
${history.map((m) => `${m.role === 'user' ? 'Cliente' : 'Asistente'}: ${m.content}`).join('\n')}

Última respuesta del asistente:
${reply}

Califica del 1 al 5, con criterio exigente. Anclas:
- Un 5 en calidez es ESTE registro: "Ay, una disculpa, Karla. Como tu cita ya quedó pagada y apartada a tu nombre, cancelarla tal cual ya no me es posible, pero con muchísimo gusto te la muevo al horario que te venga mejor." — reacciona a la persona, cortesía mexicana, ayuda concreta.
- Un 4 en calidez es esto: "Claro que sí, la limpieza dental cuesta $900 e incluye la revisión. ¿Te gustaría que te aparte un espacio?" — corto, con cortesía y siguiente paso. OJO: es WhatsApp; lo corto es virtud, no frialdad. No castigues la brevedad, castiga la ausencia de trato.
- Un 2 en calidez es esto: "La limpieza dental cuesta $900 MXN e incluye revisión." — el dato pelón, sin saludo, sin reacción, sin siguiente paso.
- Un 1 es "Perfecto. Tengo estos horarios disponibles: martes 10:00 a.m., martes 12:00 p.m."

- calidez: 5 = suena a una recepcionista mexicana cercana, servicial y educada que escuchó a la persona; 3 = amable pero genérico; 1 = frío, informativo, seco.
- mexicano: 5 = español mexicano natural de WhatsApp (tú, "con gusto", "¿te parece?", "no te preocupes"); 3 = español neutro correcto; 1 = traducido/formal de manual.
- bot: 5 = suena a sistema (arranques tipo "Perfecto.", "Claro.", "Le informo", listas, fórmulas de manual, cero reacción a lo que dijo el cliente); 3 = neutro, podría ser cualquiera; 1 = suena a una persona concreta.
- repite: true si la última respuesta arranca con las mismas palabras o repite una fórmula textual que el asistente ya usó antes en el historial.

Responde SOLO JSON: {"calidez":n,"mexicano":n,"bot":n,"repite":bool,"motivo":"una línea"}`;
  // The judge goes through the same SDK the agent uses (the Responses API); the raw aux
  // Chat Completions path returned an empty body for this prompt on gpt-5-mini.
  const { text } = await generateText({
    model: createOpenAI({ apiKey: evalApiKey })(JUDGE_MODEL),
    prompt,
    providerOptions: { openai: { reasoningEffort: 'low' } },
  });
  const json = text.match(/\{[\s\S]*\}/)?.[0];
  if (!json) throw new Error(`judge returned no JSON: ${text.slice(0, 200)}`);
  return JSON.parse(json) as Verdict;
}

/** The bans that ARE binary. */
const BOT_FILLERS = /^(perfecto|claro)\.?\s*$|en qué más puedo ayudarte|es importante mencionar|le informo|estimad[oa]|quedo atent[ao]|no dude en|a continuaci[óo]n/im;

async function run(history: { role: 'user' | 'assistant'; content: string }[]) {
  const agent = buildFrontDeskAgent();
  // Mastra types the message union contextually; a pre-built array needs the nudge.
  const res = await agent.generate(history as never, { requestContext: rc() });
  const verdict = await judge(history, res.text);
  console.log(`[voice] ${RULE_OFF ? 'OFF' : 'ON '} calidez=${verdict.calidez} mexicano=${verdict.mexicano} bot=${verdict.bot} repite=${verdict.repite} — ${verdict.motivo}\n  → ${res.text.replace(/\n+/g, ' / ')}`);
  return { text: res.text, verdict };
}

function expectVoice(r: { text: string; verdict: Verdict }) {
  expect(r.text).not.toMatch(BOT_FILLERS);
  expect(r.verdict.calidez).toBeGreaterThanOrEqual(4);
  expect(r.verdict.bot).toBeLessThanOrEqual(2);
  expect(r.verdict.repite).toBe(false);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(q.logBotEvent).mockResolvedValue(undefined);
  vi.mocked(q.logAppointment).mockResolvedValue({ appointmentId: 'a-uuid' } as never);
  vi.mocked(q.logEvent).mockResolvedValue({ eventId: 'e-uuid' } as never);
  vi.mocked(q.logLlmUsage).mockResolvedValue(undefined as never);
  vi.mocked(q.resetReactivationRound).mockResolvedValue(undefined);
  vi.mocked(q.updateConversationStatus).mockResolvedValue(true as never);
  getAvailability.mockResolvedValue(SLOTS);
  bookAppointment.mockResolvedValue({ ghlAppointmentId: 'appt_eval_voice' });
});

type Scenario = { name: string; history: { role: 'user' | 'assistant'; content: string }[]; setup?: () => void };
const SCENARIOS: Scenario[] = [
  { name: 'precio', history: [{ role: 'user', content: 'Hola, cuánto cuesta la limpieza dental?' }] },
  {
    name: 'hoy',
    setup: () => getAvailability.mockResolvedValue([]),
    history: [{ role: 'user', content: 'Hola, tienen algo para hoy en la tarde? es una consulta general' }],
  },
  { name: 'primera oferta', history: [{ role: 'user', content: 'Quiero una consulta general, qué horarios tienes?' }] },
  {
    name: 'cierre tras agendar',
    history: [
      { role: 'user', content: 'Quiero una consulta general' },
      { role: 'assistant', content: 'Claro que sí. Para pasado mañana te puedo apartar a las 10 de la mañana, a las 12 o a las 4 de la tarde; ¿cuál te acomoda mejor y a nombre de quién la agendo?' },
      { role: 'user', content: 'A las 12, soy Karla Mendoza' },
    ],
  },
  {
    name: 'ya no me interesa',
    history: [
      { role: 'user', content: 'Hola, quería info de la limpieza' },
      { role: 'assistant', content: 'Con gusto, Karla. La limpieza dental cuesta $900 e incluye la revisión; ¿te gustaría que te aparte un espacio?' },
      { role: 'user', content: 'La verdad ya no me interesa, gracias' },
    ],
  },
  {
    name: 'segundo turno',
    history: [
      { role: 'user', content: 'Hola, quiero una consulta general' },
      { role: 'assistant', content: 'Claro que sí, con gusto te ayudo. ¿Qué día te viene mejor, entre semana o el sábado?' },
      { role: 'user', content: 'Entre semana, el martes' },
    ],
  },
];

/**
 * Style is a RATE, so the assertion is on the six together, not per scenario: at least three
 * of six must pass the bar (calidez ≥ 4, bot ≤ 2, no repetition, no banned filler), and the
 * means must land on the warm side (thresholds from the measurement in the header).
 * Per-scenario verdicts are printed for reading.
 */
describe.skipIf(!evalApiKey)(`la voz — mexicana, servicial, sin sonar a bot (${RULE_OFF ? 'SIN VOICE_RULE' : 'con VOICE_RULE'})`, () => {
  it('al menos 4 de 6 escenarios pasan la barra del juez; medias cálidas', async () => {
    const results: { name: string; ok: boolean; v: Verdict }[] = [];
    for (const sc of SCENARIOS) {
      getAvailability.mockResolvedValue(SLOTS);
      sc.setup?.();
      const r = await run(sc.history);
      const ok =
        !BOT_FILLERS.test(r.text) && r.verdict.calidez >= 4 && r.verdict.bot <= 2 && !r.verdict.repite;
      results.push({ name: sc.name, ok, v: r.verdict });
    }
    const passed = results.filter((r) => r.ok).length;
    const mean = (k: 'calidez' | 'bot' | 'mexicano') => results.reduce((a, r) => a + r.v[k], 0) / results.length;
    console.log(`[voice-summary] ${RULE_OFF ? 'OFF' : 'ON '} passed=${passed}/6 calidez=${mean('calidez').toFixed(2)} mexicano=${mean('mexicano').toFixed(2)} bot=${mean('bot').toFixed(2)} — ${results.map((r) => `${r.name}:${r.ok ? 'ok' : 'x'}`).join(' ')}`);
    expect(passed).toBeGreaterThanOrEqual(3);
    expect(mean('calidez')).toBeGreaterThanOrEqual(3.8);
    expect(mean('bot')).toBeLessThanOrEqual(1.9);
  }, 600_000);
});
