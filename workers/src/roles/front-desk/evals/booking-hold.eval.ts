/**
 * Apartado con pago (0062) — la cita se confirma cuando el lead paga.
 *
 * Con `booking_payment` en el tenant, bookAppointment ya no confirma: aparta el lugar y
 * devuelve la liga de Stripe y la fecha límite. Lo que el prompt tiene que lograr es que
 * el modelo RELAYE esas dos cosas tal cual y deje de decir "confirmada" — el reflejo que
 * trae de todos los demás tenants, donde agendar SÍ confirma. Un lead que lee "confirmada"
 * y no paga llega a una cita que el cron ya canceló.
 *
  * El tool está mockeado (la liga y el plazo son fijos); el modelo es real. `HOLD_RULE_OFF=1`
 * recorta la sección "# Apartado con pago" del prompt y deja al modelo solo con lo que dice
 * el resultado del tool.
 *
 *   MEDIDO 2026-09-20 (corridas seriadas, `--fileParallelism=false`):
 *   - gpt-5.6-luna: tras agendar 3/3 con la sección · 3/3 sin ella; "¿ya quedó?" 3/3 · 3/3.
 *   - gpt-5-mini:   igual, 3/3 · 3/3 en los dos casos (las 5 fallas de la primera medición
 *     eran de las aserciones, no del modelo: "aparté" no casaba con /apartad/, y "te llegará
 *     la confirmación en cuanto pagues" caía en una prohibición pensada para "te llegará la
 *     confirmación" a secas; ambas se corrigieron).
 *   Lectura honesta: la sección del prompt NO discrimina hoy. Lo que sostiene el comportamiento
 *   es el mensaje que devuelve bookAppointment (la liga, el plazo y "no digas confirmada" viajan
 *   en el resultado del tool, en código) más el historial. La sección se conserva por lo que el
 *   tool no puede decir —por qué se paga, que no hay "pago después", que una liga vencida ya no
 *   sirve— y este archivo defiende el CONTRATO del tool: la liga byte por byte, el plazo tal
 *   cual y el vocabulario. Si alguien cambia el mensaje del tool, aquí se nota.
 *
 * Live-only (necesita API key), excluido del gate de CI.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../db/queries.js');

// vi.mock factories are hoisted above every import and const, so anything they read
// has to be hoisted too.
const { RULE_OFF, CHECKOUT_URL, DUE_LABEL } = vi.hoisted(() => ({
  RULE_OFF: process.env.HOLD_RULE_OFF === '1',
  CHECKOUT_URL: 'https://checkout.stripe.com/c/pay/cs_test_a1B2c3D4e5F6g7H8',
  DUE_LABEL: 'jueves, 24 de septiembre, 12:00 p.m.',
}));

vi.mock('../prompt.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../prompt.js')>();
  if (!RULE_OFF) return mod;
  return {
    ...mod,
    buildFrontDeskInstructions: (...args: Parameters<typeof mod.buildFrontDeskInstructions>) =>
      mod.buildFrontDeskInstructions(...args).replace(/\n\n# Apartado con pago[\s\S]*?(?=\n\n# )/, ''),
  };
});

vi.mock('../tools/booking-hold.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../tools/booking-hold.js')>()),
  openBookingHold: vi.fn().mockResolvedValue({
    checkoutUrl: CHECKOUT_URL,
    dueAt: '2026-09-24T18:00:00.000Z',
    amountLabel: '$500 MXN',
    dueLabel: DUE_LABEL,
  }),
}));

const getAvailability = vi.fn();
const bookAppointment = vi.fn();
vi.mock('../../../ghl/client.js', () => ({
  GhlClient: vi.fn(() => ({
    getAvailability,
    bookAppointment,
    getAppointment: vi.fn().mockResolvedValue({ status: 'new' }),
    getContactAppointments: vi.fn().mockResolvedValue([]),
    getContactPhone: vi.fn().mockResolvedValue('+5216641234567'),
    updateContactName: vi.fn().mockResolvedValue(undefined),
    updateContactTimezone: vi.fn().mockResolvedValue(undefined),
    addContactTags: vi.fn().mockResolvedValue(undefined),
    removeContactTags: vi.fn().mockResolvedValue(undefined),
    cancelAppointment: vi.fn().mockResolvedValue(undefined),
  })),
}));

import * as q from '../../../db/queries.js';
import { buildFrontDeskAgent } from '../agent.js';
import { buildAgentRequestContext } from '../../../core/runtime-context.js';
import type { TenantContext, TurnContext } from '../../../core/types.js';
import { demoTenant } from './fixtures.js';
import { evalApiKey, evalModel, evalProvider } from './eval-model.js';

/**
 * Clínica Demo, charging $500 MXN to hold the slot for 24 h. The tool instruction pins the
 * serviceName the way every live tenant does (Heriberto's eval measured 0/3 without it: the
 * model copies the rendered services line — "Consulta general (30 min) — Primera valoración"
 * — and `calendars` has no such key). Not what this case measures.
 */
const paidTenant: TenantContext = {
  ...demoTenant,
  config: {
    ...demoTenant.config,
    services: [{ name: 'Consulta general', durationMin: 30 }],
    calendars: { 'Consulta general': 'cal_demo_general' },
    promptOverrides: {
      toolInstructions: {
        getAvailability: 'serviceName es EXACTAMENTE "Consulta general".',
        bookAppointment: 'serviceName es EXACTAMENTE "Consulta general".',
      },
    },
    bookingPayment: { amount: 500, deposit_note: 'se descuenta del costo de tu consulta' },
  },
};

const turn: TurnContext = {
  ghlConversationId: 'conv_eval_hold',
  ghlContactId: 'contact_eval_hold',
  contactPhone: '+5216641234567',
  channel: 'whatsapp',
};

const rc = (t: TurnContext = turn) =>
  buildAgentRequestContext({ tenant: paidTenant, turn: t, provider: evalProvider, model: evalModel, llmApiKey: evalApiKey });

/** Tomorrow 11:00 in the tenant's zone, the slot the lead picks. */
const DAY = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
const SLOTS = ['10:00', '11:00', '12:00', '16:00'].map((t) => ({ start: `${DAY}T${t}:00-06:00`, end: `${DAY}T${t}:00-06:00` }));

type ToolCallChunkLike = { payload: { toolName: string } };
const toolIds = (res: { toolCalls?: ToolCallChunkLike[] }) => (res.toolCalls ?? []).map((c) => c.payload.toolName);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(q.logBotEvent).mockResolvedValue(undefined);
  vi.mocked(q.logAppointment).mockResolvedValue({ appointmentId: 'a-uuid' } as never);
  vi.mocked(q.logEvent).mockResolvedValue({ eventId: 'e-uuid' } as never);
  vi.mocked(q.resetReactivationRound).mockResolvedValue(undefined);
  vi.mocked(q.updateConversationStatus).mockResolvedValue(true as never);
  getAvailability.mockResolvedValue(SLOTS);
  bookAppointment.mockResolvedValue({ ghlAppointmentId: 'appt_eval_hold' });
});

describe.skipIf(!evalApiKey)(`apartado con pago — la liga se manda tal cual y nada queda "confirmado" (${RULE_OFF ? 'SIN la sección' : 'con la sección'})`, () => {
  it('tras agendar: liga exacta, plazo, y "apartada" en vez de "confirmada"', async () => {
    const agent = buildFrontDeskAgent();
    const res = await agent.generate(
      [
        { role: 'user', content: 'Hola, quiero una consulta general' },
        { role: 'assistant', content: 'Claro. Tengo estos horarios: pasado mañana a las 10:00 a.m., 11:00 a.m., 12:00 p.m. o 4:00 p.m. ¿Cuál te acomoda y a nombre de quién agendo la cita?' },
        { role: 'user', content: 'A las 11, a nombre de Karla Mendoza' },
      ],
      { requestContext: rc() },
    );

    expect(toolIds(res)).toContain('bookAppointment');
    const text = res.text;
    // The link, byte for byte — a paraphrased or shortened URL sends the lead nowhere.
    expect(text).toContain(CHECKOUT_URL);
    // The deadline, as the tool rendered it (day + hour); the model must not re-derive it.
    expect(text).toMatch(/jueves,? 24 de septiembre/);
    expect(text).toMatch(/12:00 p\.?\s?m\./);
    // The state: apartada, not confirmada — the whole point of the feature.
    // "apartada" / "aparté" / "apartado": the verb in any form, never "confirmada".
    expect(text.toLowerCase()).toMatch(/apart/);
    expect(text.toLowerCase()).not.toMatch(/confirmad[ao]/);
  }, 120_000);

  // The turn AFTER the booking, with no tool result in hand: the lead asks whether it's
  // done. Without the section the model has only the previous message to go on, and
  // "¿ya quedó?" invites a "sí". With it, the answer is apartada-until-paid, read from
  // lookupAppointment (the hold is still pending).
  it('"¿ya quedó?" antes de pagar: sigue apartada, no confirmada', async () => {
    const start = `${DAY}T11:00:00-06:00`;
    vi.mocked(q.loadAppointmentLog).mockResolvedValue([
      { ghlAppointmentId: 'appt_eval_hold', appointmentDatetime: start, serviceType: 'Consulta general', action: 'booked', createdAt: new Date().toISOString() },
    ] as never);
    vi.mocked(q.getBookingHold).mockResolvedValue({
      id: 'h1', ghlAppointmentId: 'appt_eval_hold', stripeSessionId: 'cs_1', checkoutUrl: CHECKOUT_URL,
      amountCents: 50000, currency: 'mxn', status: 'pending', dueAt: '2026-09-24T18:00:00.000Z', paidAt: null,
    });
    const agent = buildFrontDeskAgent();
    const res = await agent.generate(
      [
        { role: 'user', content: 'Hola, quiero una consulta general' },
        { role: 'assistant', content: 'Claro. Tengo estos horarios: pasado mañana a las 10:00 a.m., 11:00 a.m., 12:00 p.m. o 4:00 p.m. ¿Cuál te acomoda y a nombre de quién agendo la cita?' },
        { role: 'user', content: 'A las 11, a nombre de Karla Mendoza' },
        { role: 'assistant', content: `Listo, Karla: te aparté la consulta general para pasado mañana a las 11:00 a.m. Para confirmarla, paga el apartado de $500 MXN antes del ${DUE_LABEL} en esta liga: ${CHECKOUT_URL}` },
        { role: 'user', content: 'Ok gracias, entonces ya quedó mi cita?' },
      ],
      { requestContext: rc({ ...turn, activeAppointment: { startTime: start, service: 'Consulta general' } }) },
    );

    const text = res.text.toLowerCase();
    expect(text).not.toMatch(/confirmad[ao]|ya qued[óo]|est[áa] lista/);
    expect(text).toMatch(/apartad|pag/);
  }, 120_000);
});
