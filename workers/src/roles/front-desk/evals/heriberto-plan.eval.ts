/**
 * Dr. Heriberto Valdivia — variante `i01` (keyword PLAN): "Primera Visita de Armonización
 * Facial", la única campaña del tenant que se reserva con depósito ($500 por Stripe Connect,
 * `booking_payment.only_variants = ["i01"]`).
 *
 * Lo que la oferta pone en riesgo son dos números y una palabra:
 *  1. "Gratis". El FAQ del tenant dice que la valoración estética no tiene costo — verdad para
 *     las demás campañas, falso aquí. La variante lo desactiva en su sección "# El crédito y el
 *     depósito"; sin ella, lookupFaq le trae al modelo "no tiene costo" justo cuando preguntan.
 *  2. $1,500. El crédito es de $1,000 EN TOTAL y el depósito de $500 va dentro. Leo no quiere
 *     que el bot explique la mecánica por iniciativa propia (sobre-explica), pero tampoco que
 *     un lead que sume 500 + 1,000 se quede con el "sí".
 *  3. Los precios "desde" + el depósito, juntos y con dos horarios, cuando piden precio.
 *
 * `PLAN_RULE_OFF=1` quita "# El crédito y el depósito" de qualificationNotes (el `deposit_note`
 * del booking_payment sigue: es config, no la regla).
 *
 *   MEDIDO 2026-09-26 en gpt-5.6-luna (seriado, 3 corridas por lado):
 *   - "¿la evaluación es gratis?": con la sección 3/3 · SIN ella 0/3 — las tres corridas rojas
 *     dicen "sin costo" (lookupFaq trae la entrada de la valoración). Este caso SÍ discrimina.
 *   - "PLAN", "¿cuánto cuesta?", "¿son $1,500?": 3/3 en los dos lados (una corrida verde de
 *     "¿cuánto cuesta?" murió por timeout de la API a los 60 s, no por la aserción). No los
 *     sostiene la sección sino el offering y el deposit_note, que dicen lo mismo: son guardias
 *     de que la oferta se presenta completa y de que los dos números nunca se suman.
 *
 * Live cases need an API key (`pnpm eval`); excluded from the CI gate.
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
import { buildFrontDeskInstructions } from '../prompt.js';
import { parseFrontDeskConfig, scopeBookingPayment } from '../config.js';
import { buildAgentRequestContext } from '../../../core/runtime-context.js';
import type { TenantContext, TurnContext } from '../../../core/types.js';
import { HERIBERTO_PLAN_VARIANT, heribertoTenant } from './fixtures.js';
import { evalApiKey, evalModel, evalProvider } from './eval-model.js';

const RULE_OFF = process.env.PLAN_RULE_OFF === '1';
const CREDIT_SECTION = '# El crédito y el depósito';

/** Drop one section (`# Title` … up to the next `# `). */
const withoutSection = (text: string, title: string): string => {
  const start = text.indexOf(title);
  if (start < 0) throw new Error(`section not found: ${title}`);
  const next = text.indexOf('\n# ', start + 1);
  return (text.slice(0, start) + (next < 0 ? '' : text.slice(next + 1))).trim();
};

const variant = RULE_OFF
  ? { ...HERIBERTO_PLAN_VARIANT, qualificationNotes: withoutSection(HERIBERTO_PLAN_VARIANT.qualificationNotes, CREDIT_SECTION) }
  : HERIBERTO_PLAN_VARIANT;

/** Mirrors prod's booking_payment for the tenant (minus the connected account: nothing is charged here). */
const planTenant: TenantContext = {
  ...heribertoTenant,
  config: {
    ...heribertoTenant.config,
    promptVariants: { i01: variant },
    bookingPayment: {
      amount: 500,
      hold_hours: 24,
      deposit_note: 'forma parte de tu crédito de $1,000 para el tratamiento',
      only_variants: ['i01'],
    },
  },
};

const turn: TurnContext = {
  ghlConversationId: 'conv_eval_heriberto_plan',
  ghlContactId: 'contact_eval_heriberto_plan',
  contactPhone: '+526141234567',
  channel: 'whatsapp',
  promptVariant: 'i01',
};

const rc = () =>
  buildAgentRequestContext({ tenant: planTenant, turn, provider: evalProvider, model: evalModel, llmApiKey: evalApiKey });

type ToolCallChunkLike = { payload: { toolName: string } };
const toolIds = (res: { toolCalls?: ToolCallChunkLike[]; text?: string }): string[] => {
  const ids = (res.toolCalls ?? []).map((c) => c.payload.toolName);
  if (process.env.EVAL_DEBUG) console.log('[eval] tools:', ids.join(','), '\n[eval] text:', res.text);
  return ids;
};
const reply = (res: { text: string }) => res.text.trim().toLowerCase();

const nextWeekday = (): string => {
  const d = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
  while ([0, 6].includes(d.getUTCDay())) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};
const DAY = nextWeekday();
const SLOTS = [`${DAY}T16:15:00-06:00`, `${DAY}T18:15:00-06:00`].map((start) => ({ start, end: start }));

const OPENER =
  '¡Hola! Gracias por escribirnos 😊 Soy Sofía, del consultorio del Dr. Heriberto Valdivia. Tenemos disponible nuestra Primera Visita de Armonización Facial: el doctor evalúa tus objetivos y te explica si Botox, ácido hialurónico u otra opción puede ser adecuada para ti. Además, recibes $1,000 de crédito para tu tratamiento si decides avanzar dentro de los 7 días siguientes a tu visita. ¿Te interesa conocer los horarios disponibles?';

const FREE = /gratis|sin costo|no tiene costo|sin cargo|cortes[ií]a/;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(q.logBotEvent).mockResolvedValue(undefined);
  vi.mocked(q.getActiveDemoSession).mockResolvedValue(null);
  getAvailability.mockResolvedValue(SLOTS);
});

describe('Heriberto i01 (PLAN) — prompt (offline)', () => {
  const config = parseFrontDeskConfig(planTenant.config);

  it('the deposit section renders under i01 and nowhere else', () => {
    const plan = buildFrontDeskInstructions(scopeBookingPayment(config, 'i01'), new Date().toISOString(), turn.contactPhone, undefined, undefined, undefined, 'i01');
    const other = buildFrontDeskInstructions(scopeBookingPayment(config, 'a02'), new Date().toISOString(), turn.contactPhone, undefined, undefined, undefined, 'a02');
    expect(plan).toContain('# Apartado con pago');
    expect(plan).toContain('$1,000 de crédito');
    expect(other).not.toContain('# Apartado con pago');
  });
});

describe.skipIf(!evalApiKey)(`Heriberto i01 (PLAN) — live (${RULE_OFF ? 'SIN' : 'con'} "${CREDIT_SECTION}")`, () => {
  it('"PLAN": presenta la visita y el crédito de $1,000, sin precios ni "gratis"', async () => {
    const res = await buildFrontDeskAgent().generate([{ role: 'user', content: 'PLAN' }], { requestContext: rc() });
    toolIds(res);
    const text = reply(res);
    expect(text).toMatch(/armonizaci[oó]n/);
    expect(text).toMatch(/1,?000/);
    expect(text).not.toMatch(FREE);
    expect(text).not.toMatch(/2,?000|5,?500/);
  });

  it('"¿cuánto cuesta?": los dos "desde", el depósito de $500 y dos horarios — nunca $1,500', async () => {
    const res = await buildFrontDeskAgent().generate(
      [
        { role: 'user', content: 'PLAN' },
        { role: 'assistant', content: OPENER },
        { role: 'user', content: 'Cuánto cuesta?' },
      ],
      { requestContext: rc() },
    );
    const tools = toolIds(res);
    const text = reply(res);
    expect(text).toMatch(/2,?000/);
    expect(text).toMatch(/5,?500/);
    expect(text).toMatch(/\$?500\b/);
    expect(text).not.toMatch(/1,?500/);
    expect(text).not.toMatch(FREE);
    expect(tools).toContain('getAvailability');
  });

  it('"¿la evaluación es gratis?": no lo es — se reserva con el depósito de $500', async () => {
    const res = await buildFrontDeskAgent().generate(
      [
        { role: 'user', content: 'PLAN' },
        { role: 'assistant', content: OPENER },
        { role: 'user', content: 'Y la consulta de valoración es gratis?' },
      ],
      { requestContext: rc() },
    );
    toolIds(res);
    const text = reply(res);
    // "no es gratis" still teaches the word — the rule is that it never appears.
    expect(text).not.toMatch(FREE);
    expect(text).toMatch(/\$?500\b/);
    expect(vi.mocked(q.logEvent).mock.calls.some((c) => JSON.stringify(c).includes('pending_info'))).toBe(false);
  });

  it('"¿entonces son $1,500 de crédito?": $1,000 en total, el depósito va incluido', async () => {
    const res = await buildFrontDeskAgent().generate(
      [
        { role: 'user', content: 'PLAN' },
        { role: 'assistant', content: OPENER },
        { role: 'user', content: 'Cuánto cuesta?' },
        {
          role: 'assistant',
          content:
            'Botox desde $2,000 y ácido hialurónico desde $5,500; el precio final depende de la evaluación, la zona y la cantidad indicada. Para reservar se paga un depósito de $500, que forma parte de tu crédito para el tratamiento. Tengo el lunes a las 4:15 p.m. o a las 6:15 p.m., ¿cuál te funciona mejor?',
        },
        { role: 'user', content: 'O sea que pago 500 y me dan 1000 de credito, entonces son 1500?' },
      ],
      { requestContext: rc() },
    );
    toolIds(res);
    const text = reply(res);
    expect(text).toMatch(/1,?000/);
    expect(text).toMatch(/incluid|dentro|parte|en total/);
    expect(text).not.toMatch(/(s[ií],?\s+(son|ser[ií]an)|recibes|tendr[ií]as|te quedan)\s+\$?1,?500/);
  });
});
