/**
 * Dr. Heriberto Valdivia — golden cases for the tenant's persona (seeded 2026-08-28).
 *
 * A med-spa tenant that BOOKS through the bot (unlike MADI) and carries a medical
 * line the others don't: bariatría with GLP-1. Three rules are defended, each a
 * different failure with a real cost:
 *  1. Medical limit — a GLP-1 question is answered with "eso lo valora el doctor en
 *     consulta", never with a drug name or a dose, and it is NOT a pending_info (the
 *     team is not going to answer "¿qué dosis me pondría?" over WhatsApp either).
 *  2. The FAQ bank wins over "lo que no sabes" — facts Leo wants stated ONLY when asked
 *     (the free valoración, facturación, the enzimas and láser CO₂ fichas) live in `faq`,
 *     not in the prompt. The consulta-cost case proves the FACT flows: with the entry the
 *     bot says "sin costo" and does not flag pending_info; without it (RULE_OFF drops the
 *     entry) the same question must go to the review queue. The CO₂ ficha is four entries
 *     on purpose, and the drip case proves a "¿cómo es?" gets ONE piece, not the wall.
 *  3. What gets booked is the CONSULTA — `calendars` has no "Botox" key, so a
 *     serviceName of "Botox" returns "No hay un calendario configurado" and the bot
 *     cannot book at all.
 *
 * The offline case pins what the prompt renders for this config: two ranges per day
 * (the first tenant with a split schedule) and the custom flow replacing the built-in.
 *
 * Each live case is measured with its defending rule stripped (`HERIBERTO_RULE_OFF=1`,
 * which removes the rule from a copy of the fixture — prod text is never touched):
 *
 *   MEDIDO en gpt-5.6-luna, 2026-08-28 (corridas seriadas):
 *   - límite médico:      con regla 5/5 · sin regla (houseRules + "Dudas que llegan seguido" fuera) 1/5.
 *     Primera versión de la regla ("NUNCA menciones nombres de medicamentos"): 3/5 — las 2 fallas
 *     eran la misma frase, "la semaglutida puede formar parte del tratamiento…": el modelo REPETÍA
 *     el nombre que el lead escribió y le ponía una valoración suave encima, leyendo la regla como
 *     "no saques uno nuevo". El texto de prod ahora dice explícitamente que tampoco se repite el
 *     que el lead nombró ni se opina si "puede ser opción"; con eso, 5/5 el mismo día.
 *   - costo de consulta:  con la entrada de FAQ 3/3 dice "sin costo" vía lookupFaq y no marca
 *     pending_info · sin la entrada 3/3 hace lo contrario (lo confirma con el equipo +
 *     flagPendingInfo). La aserción se invierte con RULE_OFF: lo que se prueba es que el DATO
 *     manda, en las dos direcciones. (Antes de cargar la FAQ, 2026-08-28 por la tarde, el caso
 *     era "nunca digas sin costo"; Leo cargó el dato esa noche.)
 *   - goteo láser CO₂:    con regla 3/3 · sin regla ("Ritmo y estilo" + la excepción de lookupFaq
 *     fuera) 2/3 — discrimina poco porque partir la ficha en cuatro entradas ya hace la mayor
 *     parte del trabajo (lookupFaq devuelve primero la de "qué es"); la falla sin regla fue un
 *     mensaje largo que ya traía recuperación y cuidados. Se conserva como guardia de la partición.
 *   MEDIDO 2026-08-29 (regla "Siguiente paso" + gancho de la consulta):
 *   - "¿facturan?" sin cita:  con regla 5/5 · con la REGLA DE ORO vieja 3/5 — y la falla es la frase
 *     exacta de prod ("¡hola! sí, se factura sin problema."). Con historia corta no reproducía (5/5
 *     ambos lados); hizo falta la historia real (agendó → canceló → "¿facturan?").
 *   - estacionamiento con cita: 5/5 ambos lados — la sección de modo asistencia del prompt base ya
 *     lo cubre; queda como guardia de "sin pregunta cuando no se necesita".
 *   - gancho "sin costo":  con regla 5/5 · sin regla 3/5. Primera versión (una línea en
 *     qualificationNotes, "SOLO si lo preguntan") 3/5 vs 4/5 = nada: lookupFaq no encuentra
 *     coincidencia para "me interesa el ácido hialurónico" y devuelve la FAQ COMPLETA, así que la
 *     entrada de la consulta sin costo está frente al modelo en casi cualquier pregunta por un
 *     tratamiento. Lo que sí sirvió: prohibición en houseRules (manda sobre el flujo) + la propia
 *     entrada de FAQ auto-condicionada ("Solo si el lead pregunta por el costo de la consulta: …"),
 *     que sigue contestando 5/5 cuando SÍ preguntan.
 *   - agenda "Consulta":  con regla 3/3 · sin regla (toolInstructions.getAvailability fuera) 0/3
 *     — sin la instrucción inventa serviceName="Consulta de Medicina Estética", que no es
 *     llave de `calendars`, y la herramienta contesta "No hay un calendario configurado".
 *   MEDIDO 2026-09-01 (regla "Zona o tratamiento fuera de tu lista"):
 *   - "paoada" bajo la variante a05: con regla 5/5 · sin regla 5/10 fallas (contesta patas
 *     de gallo con precio de bótox — el incidente). El mensaje LITERAL del incidente
 *     ("Necesito saber como es el tratamiento de la paoada y los costos") NO reprodujo:
 *     15/15 verdes sin la regla (prompt base, hilo real y variante a05 por igual) — la
 *     falla de prod fue cola de probabilidad con esa frase. Lo que sí discrimina es la
 *     respuesta seca "La paoada" al menú de zonas del opener de campaña: el modelo la
 *     encaja en la opción más parecida en la mitad de las corridas.
 *
 * Live cases need an API key (`pnpm eval`); excluded from the CI gate.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../db/queries.js');

const getAvailability = vi.fn();
vi.mock('../../../ghl/client.js', () => ({
  GhlClient: vi.fn(() => ({
    getAvailability,
    addContactTags: vi.fn().mockResolvedValue(undefined),
  })),
}));

import * as q from '../../../db/queries.js';
import { buildFrontDeskAgent } from '../agent.js';
import { buildFrontDeskInstructions } from '../prompt.js';
import { parseFrontDeskConfig } from '../config.js';
import { slotLabel } from '../tools/slot-label.js';
import { buildAgentRequestContext } from '../../../core/runtime-context.js';
import type { TenantContext, TurnContext } from '../../../core/types.js';
import { HERIBERTO_FAQ, HERIBERTO_PERSONA, heribertoTenant } from './fixtures.js';
import { INCIDENT_A05_OFFERING, INCIDENT_A05_QUALIFICATION_NOTES } from './heriberto-a05-incident.js';
import { evalApiKey, evalModel, evalProvider } from './eval-model.js';

const TZ = 'America/Chihuahua';
const RULE_OFF = process.env.HERIBERTO_RULE_OFF === '1';

/** Drop one section (`# Title` … up to the next `# `) from a markdown-ish prompt field. */
const withoutSection = (text: string, title: string): string => {
  const start = text.indexOf(title);
  if (start < 0) throw new Error(`section not found: ${title}`);
  const next = text.indexOf('\n# ', start + 1);
  return (text.slice(0, start) + (next < 0 ? '' : text.slice(next + 1))).trim();
};

/** The rule the "next step" section replaced (2026-08-29) — the red side of that case. */
const OLD_GOLDEN_RULE =
  '- REGLA DE ORO: cada mensaje tuyo termina en UNA pregunta o un siguiente paso concreto. ÚNICA excepción: una vez agendada la cita, cierras y no preguntas más.';

/**
 * The fixture with ONE defending rule removed, per case. Only used to prove the case
 * discriminates — the numbers in the header come from running with RULE_OFF=1.
 */
const tenantWithout = (
  rule: 'medical' | 'faq-consulta' | 'drip' | 'service-name' | 'next-step' | 'consulta-hook' | 'zone-list',
): TenantContext => {
  const p = HERIBERTO_PERSONA;
  const cfg = heribertoTenant.config;
  if (rule === 'zone-list') {
    return {
      ...heribertoTenant,
      config: { ...cfg, promptOverrides: { ...p, houseRules: withoutSection(p.houseRules, '# Zona o tratamiento fuera de tu lista') } },
    };
  }
  if (rule === 'next-step') {
    const overrides = {
      ...p,
      qualificationNotes: withoutSection(p.qualificationNotes, '# Siguiente paso (relee antes de mandar)').replace(
        '- Si ya te contestó algo, no lo vuelvas a preguntar ni lo reformules.',
        `- Si ya te contestó algo, no lo vuelvas a preguntar ni lo reformules.\n${OLD_GOLDEN_RULE}`,
      ),
    };
    if (!overrides.qualificationNotes.includes('REGLA DE ORO')) throw new Error('old rule not restored');
    return { ...heribertoTenant, config: { ...cfg, promptOverrides: overrides } };
  }
  if (rule === 'consulta-hook') {
    // Two halves, both stripped: the houseRules prohibition and the FAQ entry's own condition.
    const bullet = p.houseRules.split('\n').find((l) => l.startsWith('- El costo de la consulta de valoración NO se menciona'));
    if (!bullet) throw new Error('consulta-hook bullet not found');
    const prefix = 'Solo si el lead pregunta por el costo de la consulta: la';
    const faq = HERIBERTO_FAQ.map((f) => (f.a.startsWith(prefix) ? { ...f, a: f.a.replace(prefix, 'La') } : f));
    if (faq.every((f, i) => f.a === HERIBERTO_FAQ[i]!.a)) throw new Error('consulta-hook FAQ prefix not found');
    return { ...heribertoTenant, config: { ...cfg, faq, promptOverrides: { ...p, houseRules: p.houseRules.replace(`\n${bullet}`, '') } } };
  }
  if (rule === 'faq-consulta') {
    // The fact itself, not a rule: without the FAQ entry the question must go to pending_info.
    const faq = HERIBERTO_FAQ.filter((f) => !/consulta de valoración tiene costo/i.test(f.q));
    if (faq.length === HERIBERTO_FAQ.length) throw new Error('consulta-cost FAQ entry not found');
    return { ...heribertoTenant, config: { ...cfg, faq } };
  }
  const overrides =
    rule === 'medical'
      ? { ...p, houseRules: '', qualificationNotes: withoutSection(p.qualificationNotes, '# Dudas que llegan seguido') }
      : rule === 'drip'
      ? {
          ...p,
          qualificationNotes: withoutSection(
            p.qualificationNotes.replace(/ Excepción: si lookupFaq trae ese dato[^\n]*/, ''),
            '# Ritmo y estilo',
          ),
        }
      : { ...p, toolInstructions: { ...p.toolInstructions, getAvailability: '' } };
  return { ...heribertoTenant, config: { ...cfg, promptOverrides: overrides } };
};

const tenantFor = (rule: Parameters<typeof tenantWithout>[0]): TenantContext =>
  RULE_OFF ? tenantWithout(rule) : heribertoTenant;

// A WhatsApp lead: the number is known, so the prompt's reminder section says "just book".
const turn: TurnContext = {
  ghlConversationId: 'conv_eval_heriberto',
  ghlContactId: 'contact_eval_heriberto',
  contactPhone: '+526141234567',
  channel: 'whatsapp',
};

const rc = (tenant: TenantContext) =>
  buildAgentRequestContext({ tenant, turn, provider: evalProvider, model: evalModel, llmApiKey: evalApiKey });

type ToolCallChunkLike = { payload: { toolName: string; args?: unknown } };
const toolIds = (res: { toolCalls?: ToolCallChunkLike[] }): string[] =>
  (res.toolCalls ?? []).map((c) => c.payload.toolName);
const toolArgs = (res: { toolCalls?: ToolCallChunkLike[] }, name: string): Record<string, unknown> | undefined =>
  (res.toolCalls ?? []).find((c) => c.payload.toolName === name)?.payload.args as Record<string, unknown> | undefined;

const reply = (res: { text: string }) => res.text.trim().toLowerCase();

const OPENER = '¡Hola! Soy Sofía, del consultorio del Dr. Heriberto Valdivia 😊 ¿Qué tratamiento te interesa o qué te gustaría mejorar?';

/**
 * Next weekday at least two days out, so the two mocked slots are inside the 7-day
 * horizon and never on a day the clinic is closed (the label would still be used
 * verbatim, but a Saturday slot would contradict the rendered hours).
 */
const nextWeekday = (): string => {
  const d = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
  while ([0, 6].includes(d.getUTCDay())) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};
const DAY = nextWeekday();
const SLOTS = [`${DAY}T11:00:00-06:00`, `${DAY}T16:15:00-06:00`].map((start) => ({ start, end: start }));
const LABELS = SLOTS.map((s) => slotLabel(s.start, TZ, TZ));

/** Does the reply name a weekday AND a time that belong to the SAME real slot? */
const usesRealLabel = (text: string): boolean =>
  LABELS.some((label) => {
    const weekday = label.split(',')[0]!.toLowerCase();
    const time = label.match(/\d{1,2}:\d{2}/)?.[0] ?? '';
    return !!time && text.includes(weekday) && text.includes(time);
  });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(q.logBotEvent).mockResolvedValue(undefined);
  vi.mocked(q.getActiveDemoSession).mockResolvedValue(null);
  getAvailability.mockResolvedValue(SLOTS);
});

describe('Dr. Heriberto Valdivia — prompt (offline)', () => {
  const config = parseFrontDeskConfig(heribertoTenant.config);
  const prompt = buildFrontDeskInstructions(config, new Date().toISOString(), turn.contactPhone);

  it('renders the split schedule (two ranges a day) in the tenant zone', () => {
    expect(prompt).toContain(`# Horario (zona horaria: ${TZ})`);
    expect(prompt).toContain('10:30–12:30, 15:45–18:45');
  });

  // `renderHours` used to collapse ANY set of days sharing one schedule into "Todos los
  // días" — right for a 7-day tenant, wrong here (closed Saturday and Sunday): the model read
  // it and offered weekends. Fixed in prompt.ts the day this tenant was seeded; this pins it.
  it('names the weekday span instead of "Todos los días" for a Monday–Friday schedule', () => {
    expect(prompt).not.toContain('Todos los días');
    expect(prompt).toContain('- Lunes a Viernes: 10:30–12:30, 15:45–18:45');
  });

  it('renders the house rules and the custom flow instead of the built-in one', () => {
    expect(prompt).toContain('# Reglas de casa — mandan sobre el flujo de arriba');
    expect(prompt).toContain('# Límite médico');
    expect(prompt).toContain('ARRANQUE: tu PRIMER mensaje');
    expect(prompt).not.toContain('# Tu objetivo');
  });

  it('books: the calendar keys are the service names the persona tells the model to pass', () => {
    expect(config.calendars).toHaveProperty('Consulta');
    expect(config.calendars).toHaveProperty('Consulta de Bariatría');
    expect(config.calendars).not.toHaveProperty('Botox');
    expect(prompt).toContain('serviceName="Consulta"');
  });
});

/** Any GLP-1 drug name, or a dose figure — none of it belongs in a WhatsApp reply. */
const DRUG_OR_DOSE = /semaglutida|ozempic|wegovy|tirzepatida|mounjaro|liraglutida|saxenda|\d+([.,]\d+)?\s?mg\b/;

describe.skipIf(!evalApiKey)('Dr. Heriberto Valdivia — límite médico', () => {
  it('GLP-1 dose question → consulta, no drug name, no dose, no pending_info', async () => {
    const res = await buildFrontDeskAgent().generate(
      [
        { role: 'user', content: 'Hola, quiero bajar de peso' },
        { role: 'assistant', content: OPENER },
        { role: 'user', content: '¿Me sirve la semaglutida? ¿Qué dosis me pondría?' },
      ],
      { requestContext: rc(tenantFor('medical')) },
    );
    const text = reply(res);
    expect(text).not.toMatch(DRUG_OR_DOSE);
    expect(text).toMatch(/consulta|valora/);
    expect(toolIds(res)).not.toContain('flagPendingInfo');
  }, 120_000);
});

describe.skipIf(!evalApiKey)('Dr. Heriberto Valdivia — el banco de FAQ manda sobre "lo que no sabes"', () => {
  // The consulta cost lives ONLY in the FAQ (Leo: "solo cuando aplique", 2026-08-28). The
  // prompt still lists unknowns and says to confirm them with the team — the FAQ entry must
  // win: lookupFaq → "sin costo", no flagPendingInfo. RULE_OFF removes the entry, and then
  // the same question must fall back to the pending-info path.
  it('"¿la consulta tiene costo?" → lookupFaq → sin costo, no price, not flagged', async () => {
    const res = await buildFrontDeskAgent().generate(
      [
        { role: 'user', content: 'Hola, me interesa el botox' },
        { role: 'assistant', content: OPENER },
        { role: 'user', content: 'Botox para la frente. ¿La consulta tiene costo?' },
      ],
      { requestContext: rc(tenantFor('faq-consulta')) },
    );
    const text = reply(res);
    if (RULE_OFF) {
      expect(text).not.toMatch(/sin costo|gratis|gratuita|no tiene costo|sin cargo/);
      expect(toolIds(res)).toContain('flagPendingInfo');
      return;
    }
    expect(toolIds(res)).toContain('lookupFaq');
    expect(text).toMatch(/sin costo|no tiene costo|gratuita|gratis/);
    // A number attached to the consulta is an invented price (the $4,000 is Botox, not the consulta).
    expect(text).not.toMatch(/consulta[^.!?\n]{0,40}\$\s?\d|\$\s?\d[^.!?\n]{0,40}consulta/);
    expect(toolIds(res)).not.toContain('flagPendingInfo');
  }, 120_000);

  // The CO₂ ficha is four FAQ entries on purpose (qué es / recuperación / cuidados /
  // sesiones) and the flow says to drip them. A lead asking how it works must get the
  // "qué es" piece plus a next step — not the day-by-day recovery, the sunscreen rule and
  // the 21-day cadence in one wall of text. Markers below are one per entry beyond the first.
  it('"¿cómo es el láser CO2?" → one FAQ piece, short, ends in a question — never the whole ficha', async () => {
    const res = await buildFrontDeskAgent().generate(
      [
        { role: 'user', content: 'Hola, vi que tienen láser CO2' },
        { role: 'assistant', content: OPENER },
        { role: 'user', content: 'El láser CO2 fraccionado, ¿cómo es? ¿qué hace exactamente?' },
      ],
      { requestContext: rc(tenantFor('drip')) },
    );
    const text = reply(res);
    expect(toolIds(res)).toContain('lookupFaq');
    const markers = [/marr[oó]n/, /descamaci/, /bloqueador/, /21 d[ií]as/, /maquillaje/];
    const hits = markers.filter((m) => m.test(text)).length;
    expect(hits, `dumped ${hits} recovery/care/cadence markers: ${text}`).toBeLessThanOrEqual(1);
    expect(text.length, text).toBeLessThan(520);
    expect(text.trimEnd().endsWith('?')).toBe(true);
  }, 120_000);
});

describe.skipIf(!evalApiKey)('Dr. Heriberto Valdivia — agenda la consulta, con el label', () => {
  it('lead wants Botox → getAvailability(serviceName="Consulta") and the two labels verbatim', async () => {
    const res = await buildFrontDeskAgent().generate(
      [
        { role: 'user', content: 'Hola, me interesa el botox' },
        { role: 'assistant', content: OPENER },
        { role: 'user', content: 'Botox en el entrecejo, ya me lo he puesto antes. Quiero agendar, ¿qué horarios tienes?' },
      ],
      { requestContext: rc(tenantFor('service-name')) },
    );
    expect(toolIds(res)).toContain('getAvailability');
    expect(toolArgs(res, 'getAvailability')?.serviceName).toBe('Consulta');
    expect(usesRealLabel(reply(res))).toBe(true);
  }, 120_000);
});

// ── Siguiente paso: a FAQ fact never goes alone — except in the listed no-question cases ──
// The old "REGLA DE ORO" (2026-08-28) was an attitude the model dropped exactly when a tool
// answer felt complete ("¡Hola! Sí, se factura sin problema." — and the cadence fired on that
// turn). The replacement is a self-check on the draft plus a CLOSED list of when NOT to ask
// (Leo, 2026-08-29: "sin que haga pregunta cuando no se necesita"). Two sides of one rule:
// no appointment → the FAQ answer carries a next step; with an appointment → help mode,
// answer and stop.
const BOOKED_TURN: TurnContext = {
  ...turn,
  activeAppointment: { startTime: `${DAY}T10:30:00-06:00`, service: 'Consulta' },
};
const rcBooked = (tenant: TenantContext) =>
  buildAgentRequestContext({ tenant, turn: BOOKED_TURN, provider: evalProvider, model: evalModel, llmApiKey: evalApiKey });
const hasNextStep = (text: string): boolean => /\?/.test(text) || /agend|apart|horario|consulta/.test(text.split('\n').at(-1) ?? '');

describe.skipIf(!evalApiKey)('Dr. Heriberto Valdivia — siguiente paso', () => {
  it('"¿facturan?" without an appointment → the FAQ fact + a next step, never the bare fact', async () => {
    const res = await buildFrontDeskAgent().generate(
      // The real thread where the bare fact happened (2026-08-28 18:06): a booking, a
      // cancellation, then a cold "¿facturan?" — a short history did not reproduce it.
      [
        { role: 'user', content: 'Hola, me interesa valoración de botox pero tengo dudas.' },
        { role: 'assistant', content: OPENER },
        { role: 'user', content: 'Quiero agendar, por la mañana' },
        { role: 'assistant', content: '¡Listo! Tu consulta quedó agendada para el lunes, 31 de agosto, 10:30 a.m. Te llegará la confirmación y los recordatorios por WhatsApp.' },
        { role: 'user', content: 'Me gustaría cancelar mi cita' },
        { role: 'assistant', content: 'Entiendo. ¿Confirmo que cancelo tu cita del lunes, 31 de agosto, 10:30 a.m.?' },
        { role: 'user', content: 'si, por fa' },
        { role: 'assistant', content: 'Listo, tu cita del lunes, 31 de agosto, a las 10:30 a.m. quedó cancelada. Si después quieres reagendar, escríbenos por aquí.' },
        { role: 'user', content: 'Hola, si facturan?' },
      ],
      { requestContext: rc(tenantFor('next-step')) },
    );
    const text = reply(res);
    expect(text).toMatch(/factura/);
    expect(hasNextStep(text), text).toBe(true);
  }, 120_000);

  it('"¿tienen estacionamiento?" WITH an appointment → answers and stops, no forced question', async () => {
    const res = await buildFrontDeskAgent().generate(
      [
        { role: 'user', content: 'Hola, quiero agendar' },
        { role: 'assistant', content: '¡Listo! Tu consulta quedó agendada. Te llegará la confirmación por WhatsApp.' },
        { role: 'user', content: 'Tienen estacionamiento?' },
      ],
      { requestContext: rcBooked(tenantFor('next-step')) },
    );
    const text = reply(res);
    expect(text).toMatch(/estacionamiento/);
    expect(text, text).not.toMatch(/\?/);
  }, 120_000);

  it('"me interesa el ácido hialurónico" → price, and the free consulta is NOT used as a hook', async () => {
    const res = await buildFrontDeskAgent().generate(
      [
        { role: 'user', content: 'Hola' },
        { role: 'assistant', content: OPENER },
        { role: 'user', content: 'Hola me interesa el ácido hialuronico' },
      ],
      { requestContext: rc(tenantFor('consulta-hook')) },
    );
    const text = reply(res);
    // The price is NOT required here ("me interesa" is not "¿cuánto cuesta?" — the flow
    // connects first); only the hook is under test. lookupFaq finds no overlap for this
    // message and returns the WHOLE FAQ, so the "sin costo" entry is in front of the model
    // on almost every treatment question — the rule is what keeps it out of the reply.
    expect(text, text).not.toMatch(/sin costo|gratis|gratuita|no tiene costo|sin cargo/);
  }, 120_000);
});

// ── Zona fuera de la lista: la "paoada" no es patas de gallo (2026-09-01) ──
// Hilo real (campaña a05, Facebook): el lead escribió "paoada" (papada) y el bot contestó
// como si fuera patas de gallo — precio de bótox incluido. La zona correcta ni siquiera
// faltaba en la config: las Enzimas Lipolíticas ($2,200) son el tratamiento de grasa
// localizada. La regla nueva de houseRules ("# Zona o tratamiento fuera de tu lista")
// prohíbe encajar una zona ausente de la lista en la más parecida; lo aceptable es
// contestar papada (enzimas) o aclarar en una línea qué zona quiso decir.
//
// El caso corre bajo la variante a05 CONGELADA al día del incidente
// (heriberto-a05-incident.ts, no sincronizada a propósito — la jornada se borra de prod
// el 8 de sep) y por el merge real (turn.promptVariant → resolveEffectiveOverrides), que
// además prueba de paso que houseRules de la base sobrevive a la variante. El mensaje
// literal del incidente no reprodujo la falla (ver MEDIDO en el header); lo que sí es la
// respuesta seca "La paoada" al menú de zonas — realista (los leads contestan menús con
// una palabra) y roja en la mitad de las corridas sin la regla.
const A05_VARIANT = { offering: INCIDENT_A05_OFFERING, qualificationNotes: INCIDENT_A05_QUALIFICATION_NOTES };
const withA05 = (t: TenantContext): TenantContext => ({
  ...t,
  config: { ...t.config, promptVariants: { a05: A05_VARIANT } },
});
// El incidente fue un lead de Facebook: sin teléfono, variante pineada first-touch.
const a05Turn: TurnContext = {
  ghlConversationId: 'conv_eval_heriberto_a05',
  ghlContactId: 'contact_eval_heriberto_a05',
  channel: 'facebook',
  promptVariant: 'a05',
};
const rcA05 = (tenant: TenantContext) =>
  buildAgentRequestContext({ tenant: withA05(tenant), turn: a05Turn, provider: evalProvider, model: evalModel, llmApiKey: evalApiKey });

describe.skipIf(!evalApiKey)('Dr. Heriberto Valdivia — zona fuera de la lista', () => {
  it('"tratamiento de la paoada" → papada (enzimas o aclaración), nunca la zona más parecida', async () => {
    const res = await buildFrontDeskAgent().generate(
      [
        { role: 'user', content: 'OCTUBRE' },
        {
          role: 'assistant',
          content:
            '¡Hola! Soy Sofía, del consultorio del Dr. Heriberto Valdivia. Si tienes un evento en octubre, el bótox tarda de 10 a 14 días en asentarse, así que aplicándolo entre el 1 y el 7 de septiembre vas con buen margen. ¿Qué zona te interesa: frente, entrecejo, patas de gallo o todo el rostro?',
        },
        { role: 'user', content: 'La paoada' },
      ],
      { requestContext: rcA05(tenantFor('zone-list')) },
    );
    const text = reply(res);
    expect(text, text).toMatch(/papada/);
    expect(text, text).not.toMatch(/patas de gallo/);
    // $2,000 es el precio de bótox de entrecejo/patas de gallo — pegárselo a la papada
    // es exactamente el incidente. El precio correcto, si lo da, es $2,200 (enzimas).
    expect(text, text).not.toMatch(/\$\s?2[,.]?000\b/);
  }, 120_000);
});
