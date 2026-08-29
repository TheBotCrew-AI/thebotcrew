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
 *   - agenda "Consulta":  con regla 3/3 · sin regla (toolInstructions.getAvailability fuera) 0/3
 *     — sin la instrucción inventa serviceName="Consulta de Medicina Estética", que no es
 *     llave de `calendars`, y la herramienta contesta "No hay un calendario configurado".
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

/**
 * The fixture with ONE defending rule removed, per case. Only used to prove the case
 * discriminates — the numbers in the header come from running with RULE_OFF=1.
 */
const tenantWithout = (rule: 'medical' | 'faq-consulta' | 'drip' | 'service-name'): TenantContext => {
  const p = HERIBERTO_PERSONA;
  const cfg = heribertoTenant.config;
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
