/**
 * Cancel → offer to reschedule first (base prompt, every tenant that books).
 *
 * A lead who asks to cancel is a warm lead (Leo, 2026-08-28): before the bot confirms a
 * cancellation it pulls two real slots and offers to move the appointment. Only when the
 * lead insists does the explicit-confirmation rule apply, and the offer is made ONCE — a
 * second "cancélala" is not met with more slots. What happens after a real cancel
 * (standby, no nudges) is unchanged.
 *
 * Three steps of one conversation, run on the Heriberto fixture (a tenant that books):
 *  a. "necesito cancelar mi cita"  → getAvailability called, a real slot label offered,
 *     cancelAppointment NOT called.
 *  b. offer made, lead insists     → the explicit confirmation question, still no cancel.
 *  c. lead says sí                 → cancelAppointment called.
 *
 * Red side = the previous bullet ("primero confírmalo explícitamente … cancela") — the
 * rule lives in the base prompt, so it was measured by stashing the prompt.ts edit.
 *
 *   MEDIDO en gpt-5.6-luna, 2026-08-28 (corridas seriadas, 3 por lado):
 *   - a. ofrece reagendar:     con regla 3/3 · regla vieja 0/3 — sin la regla va directo a la
 *        pregunta de confirmación, sin consultar horarios.
 *   - b. confirma al insistir: con regla 3/3 · regla vieja 0/3 — con la regla vieja, "de plano
 *        cancélala" después de una oferta se leyó como confirmación y CANCELÓ en ese mismo
 *        turno ("listo, tu cita quedó cancelada"); la regla nueva mantiene la pregunta
 *        explícita aun después de la oferta. (Una corrida con regla falló solo por la
 *        redacción — "¿confirmo la cancelación…?" — y la aserción se abrió a cualquier
 *        pregunta explícita de confirmación; la regla no se tocó.)
 *   - c. cancela con el sí:    con regla 3/3 · regla vieja 3/3 (guardia de regresión).
 *
 * Live cases need an API key (`pnpm eval`); excluded from the CI gate.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../db/queries.js');

const getAvailability = vi.fn();
const cancelAppointment = vi.fn();
const getAppointment = vi.fn();
vi.mock('../../../ghl/client.js', () => ({
  GhlClient: vi.fn(() => ({
    getAvailability,
    cancelAppointment,
    getAppointment,
    getContactAppointments: vi.fn().mockResolvedValue([]),
    addContactTags: vi.fn().mockResolvedValue(undefined),
    removeContactTags: vi.fn().mockResolvedValue(undefined),
  })),
}));

import * as q from '../../../db/queries.js';
import { buildFrontDeskAgent } from '../agent.js';
import { slotLabel } from '../tools/slot-label.js';
import { buildAgentRequestContext } from '../../../core/runtime-context.js';
import type { TurnContext } from '../../../core/types.js';
import { heribertoTenant } from './fixtures.js';
import { evalApiKey, evalModel, evalProvider } from './eval-model.js';

const TZ = 'America/Chihuahua';

/** Next weekday at least two days out: inside the 7-day horizon, never a closed day. */
const nextWeekday = (): string => {
  const d = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
  while ([0, 6].includes(d.getUTCDay())) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};
const DAY = nextWeekday();

// The lead's existing appointment — and the two slots the bot may offer instead of it.
const APPT_START = `${DAY}T10:30:00-06:00`;
const APPT_LABEL = slotLabel(APPT_START, TZ, TZ);
const SLOTS = [`${DAY}T11:30:00-06:00`, `${DAY}T16:15:00-06:00`].map((start) => ({ start, end: start }));
const LABELS = SLOTS.map((s) => slotLabel(s.start, TZ, TZ));

/** Does the reply name a weekday AND a time that belong to the SAME offered slot? */
const usesRealLabel = (text: string): boolean =>
  LABELS.some((label) => {
    const weekday = label.split(',')[0]!.toLowerCase();
    const time = label.match(/\d{1,2}:\d{2}/)?.[0] ?? '';
    return !!time && text.includes(weekday) && text.includes(time);
  });

// A WhatsApp lead with an active appointment: the prompt renders help mode, whose only exit
// to the booking tools is an explicit "mover o cancelar" — exactly the path under test.
const turn: TurnContext = {
  ghlConversationId: 'conv_eval_cancel',
  ghlContactId: 'contact_eval_cancel',
  contactPhone: '+526141234567',
  channel: 'whatsapp',
  activeAppointment: { startTime: APPT_START, service: 'Consulta' },
};

const rc = () =>
  buildAgentRequestContext({ tenant: heribertoTenant, turn, provider: evalProvider, model: evalModel, llmApiKey: evalApiKey });

type ToolCallChunkLike = { payload: { toolName: string; args?: unknown } };
const toolIds = (res: { toolCalls?: ToolCallChunkLike[] }): string[] =>
  (res.toolCalls ?? []).map((c) => c.payload.toolName);
const reply = (res: { text: string }) => res.text.trim().toLowerCase();

const BOOKED = `¡Listo! Tu consulta quedó agendada para el ${APPT_LABEL}. Te llegará la confirmación y los recordatorios por WhatsApp.`;
const OFFER = `Antes de cancelarla, ¿te la muevo? Tengo el ${LABELS[0]} o el ${LABELS[1]}, ¿alguno te queda mejor?`;
const CONFIRM_Q = `Entiendo. ¿Confirmo que cancelo tu cita del ${APPT_LABEL}?`;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(q.logBotEvent).mockResolvedValue(undefined);
  vi.mocked(q.getActiveDemoSession).mockResolvedValue(null);
  vi.mocked(q.logAppointment).mockResolvedValue({ appointmentId: 'appt_eval' });
  vi.mocked(q.reactivateConversation).mockResolvedValue(undefined);
  vi.mocked(q.loadAppointmentLog).mockResolvedValue([
    { ghlAppointmentId: 'appt_eval', action: 'booked', appointmentDatetime: APPT_START, serviceType: 'Consulta', createdAt: new Date().toISOString() },
  ]);
  getAvailability.mockResolvedValue(SLOTS);
  getAppointment.mockResolvedValue({ id: 'appt_eval', status: 'confirmed', startTime: APPT_START });
  cancelAppointment.mockResolvedValue({ appointmentId: 'appt_eval' });
});

describe.skipIf(!evalApiKey)('cancelar → primero ofrecer reagendar', () => {
  it('a. "necesito cancelar mi cita" → two real slots offered, nothing cancelled', async () => {
    const res = await buildFrontDeskAgent().generate(
      [
        { role: 'user', content: 'Quiero agendar una consulta para botox' },
        { role: 'assistant', content: BOOKED },
        { role: 'user', content: 'Hola, necesito cancelar mi cita' },
      ],
      { requestContext: rc() },
    );
    const text = reply(res);
    expect(toolIds(res), text).toContain('getAvailability');
    expect(usesRealLabel(text), text).toBe(true);
    expect(toolIds(res)).not.toContain('cancelAppointment');
  }, 120_000);

  it('b. offer made, lead insists → explicit confirmation question, still no cancel', async () => {
    const res = await buildFrontDeskAgent().generate(
      [
        { role: 'user', content: 'Quiero agendar una consulta para botox' },
        { role: 'assistant', content: BOOKED },
        { role: 'user', content: 'Hola, necesito cancelar mi cita' },
        { role: 'assistant', content: OFFER },
        { role: 'user', content: 'No, de plano cancélala, ya no voy a poder' },
      ],
      { requestContext: rc() },
    );
    const text = reply(res);
    // Any explicit confirmation question about THE cancellation counts; the wording is the model's.
    expect(text).toMatch(/confirm\w*[^.?!]{0,30}cancel|¿cancelo tu cita/);
    expect(toolIds(res), text).not.toContain('cancelAppointment');
    // One offer only: no second round of slots.
    expect(toolIds(res), text).not.toContain('getAvailability');
  }, 120_000);

  it('c. lead confirms → cancelAppointment', async () => {
    const res = await buildFrontDeskAgent().generate(
      [
        { role: 'user', content: 'Quiero agendar una consulta para botox' },
        { role: 'assistant', content: BOOKED },
        { role: 'user', content: 'Hola, necesito cancelar mi cita' },
        { role: 'assistant', content: OFFER },
        { role: 'user', content: 'No, de plano cancélala, ya no voy a poder' },
        { role: 'assistant', content: CONFIRM_Q },
        { role: 'user', content: 'Sí' },
      ],
      { requestContext: rc() },
    );
    expect(toolIds(res), reply(res)).toContain('cancelAppointment');
  }, 120_000);
});
