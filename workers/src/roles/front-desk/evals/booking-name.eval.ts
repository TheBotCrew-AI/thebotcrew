/**
 * Golden cases for the name at booking time — "¿A nombre de quién agendo la cita?"
 *
 * Leads from Instagram/Facebook arrive in GHL under their social handle, and nothing in
 * the flow used to ask their name, so the confirmation GHL sends greeted the handle. The
 * booking sequence now asks for the name — ONLY when the lead hasn't said it in the
 * conversation — folded into the message that closes the hour, and passes it to
 * bookAppointment as `contactName`, which writes the contact before the booking POST.
 * The write is mechanical (tools/book-appointment.ts, unit-tested); what these cases
 * pin is the MODEL's half:
 *
 *   · unknown name + slot picked → it asks, and does NOT book yet;
 *   · the lead answers with a name → it books with that name as contactName;
 *   · the lead introduced themselves earlier → it books without asking again.
 *
 * Mocks: GHL availability returns one fixed instant; the DB is mocked wholesale.
 *
 * What each case is worth (§6c), measured on `gpt-5.6-luna`, 2026-08-29, 3 runs per side.
 * The rule lives in TWO layers — step 3 of "# Secuencia para agendar" and the `contactName`
 * description on the bookAppointment tool — so it was measured against both removed
 * (baseline) and against the prompt step alone removed:
 *
 *   · asks-before-booking: a REPRODUCTION — baseline 0/3 (the model booked straight
 *     away, no name asked); prompt step removed, tool description kept: 2/3; both
 *     present: 3/3 (and 3/3, 3/3). The tool description carries most of the rule; the
 *     prompt step closes the gap. Neither layer is redundant.
 *   · books-with-contactName: a GUARD — 3/3 on every side. Given an optional name
 *     argument the model fills it from the conversation unprompted; kept because a
 *     rename of the argument or a "no lo pases" edit would break the write silently.
 *   · no-re-ask when known: a GUARD — 3/3 on every side; kept because the step's own
 *     wording ("NO se lo vuelvas a pedir") is what a later edit could drop.
 *
 * Live-only (needs an API key); `pnpm eval`, excluded from the CI gate.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../db/queries.js');
const SLOT = '2026-09-03T18:00:00.000Z'; // 11:00 a.m. Tijuana
const ghl = {
  addContactTags: vi.fn().mockResolvedValue(undefined),
  removeContactTags: vi.fn().mockResolvedValue(undefined),
  getAvailability: vi.fn().mockResolvedValue([{ start: SLOT, end: SLOT }]),
  getContactPhone: vi.fn().mockResolvedValue('+5216641234567'),
  updateContactPhone: vi.fn().mockResolvedValue(undefined),
  updateContactName: vi.fn().mockResolvedValue(undefined),
  updateContactTimezone: vi.fn().mockResolvedValue(undefined),
  bookAppointment: vi.fn().mockResolvedValue({ ghlAppointmentId: 'appt_eval_name' }),
};
vi.mock('../../../ghl/client.js', () => ({ GhlClient: vi.fn(() => ghl) }));

import * as q from '../../../db/queries.js';
import { buildFrontDeskAgent } from '../agent.js';
import { buildAgentRequestContext } from '../../../core/runtime-context.js';
import type { TurnContext } from '../../../core/types.js';
import { botCrewTenant } from './fixtures.js';
import { evalApiKey, evalModel, evalProvider } from './eval-model.js';

const turn: TurnContext = {
  ghlConversationId: 'conv_eval_name',
  ghlContactId: 'contact_eval_name',
  contactPhone: '+5216641234567', // a number on file → no WhatsApp ask competes with the name ask
  channel: 'instagram',
};
const rc = () =>
  buildAgentRequestContext({ tenant: botCrewTenant, turn, provider: evalProvider, model: evalModel, llmApiKey: evalApiKey });

type ToolCallChunkLike = { payload: { toolName: string; args?: unknown } };
const toolIds = (res: { toolCalls?: ToolCallChunkLike[] }) => (res.toolCalls ?? []).map((c) => c.payload.toolName);
const toolArgs = (res: { toolCalls?: ToolCallChunkLike[] }, name: string) =>
  (res.toolCalls ?? []).find((c) => c.payload.toolName === name)?.payload.args as Record<string, unknown> | undefined;
const reply = (res: { text: string }) => res.text.toLowerCase();

const ASKS_NAME = /a nombre de qui[eé]n|tu nombre|c[oó]mo te llamas|con qui[eé]n tengo el gusto|me das tu nombre|me compartes tu nombre/;

// A qualified lead who never said their name, at the point where a slot was offered.
const slotOffered = [
  { role: 'user' as const, content: 'Hola, tengo una clínica estética en Tijuana, aplicamos bótox y nos escriben por Instagram todo el día.' },
  { role: 'assistant' as const, content: 'Perfecto, sí les puede servir. En una videollamada de 20 minutos, Leo te muestra el sistema funcionando con el caso de tu clínica. ¿Te aparto un espacio con Leo?' },
  { role: 'user' as const, content: 'Sí, ¿qué horarios tienes el jueves?' },
  { role: 'assistant' as const, content: 'Tengo el jueves 3 de septiembre a las 11:00 a.m. ¿Te lo aparto?' },
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(q.logBotEvent).mockResolvedValue(undefined);
  vi.mocked(q.logAppointment).mockResolvedValue({ appointmentId: 'a-uuid' } as never);
  vi.mocked(q.logEvent).mockResolvedValue({ eventId: 'e-uuid' } as never);
  vi.mocked(q.updateConversationStatus).mockResolvedValue(true);
  vi.mocked(q.resetReactivationRound).mockResolvedValue(undefined as never);
  ghl.getAvailability.mockResolvedValue([{ start: SLOT, end: SLOT }]);
  ghl.bookAppointment.mockResolvedValue({ ghlAppointmentId: 'appt_eval_name' });
});

describe.skipIf(!evalApiKey)('name at booking — asked only when unknown', () => {
  it('slot picked, name never given → asks the name and does not book yet', async () => {
    const agent = buildFrontDeskAgent();
    const res = await agent.generate([...slotOffered, { role: 'user', content: 'Sí, ese me queda bien' }], { requestContext: rc() });

    expect(reply(res)).toMatch(ASKS_NAME);
    expect(toolIds(res)).not.toContain('bookAppointment');
  });

  it('the lead answers with a name → books with it as contactName', async () => {
    const agent = buildFrontDeskAgent();
    const res = await agent.generate(
      [
        ...slotOffered,
        { role: 'user', content: 'Sí, ese me queda bien' },
        { role: 'assistant', content: 'Perfecto, te lo aparto. ¿A nombre de quién agendo la cita?' },
        { role: 'user', content: 'Karla Mendoza' },
      ],
      { requestContext: rc() },
    );

    expect(toolIds(res)).toContain('bookAppointment');
    expect(String(toolArgs(res, 'bookAppointment')?.contactName ?? '').toLowerCase()).toContain('karla');
    expect(ghl.updateContactName).toHaveBeenCalledWith('contact_eval_name', { firstName: 'Karla', lastName: 'Mendoza' });
  });

  it('the lead introduced themselves earlier → books without asking again', async () => {
    const agent = buildFrontDeskAgent();
    const res = await agent.generate(
      [
        { role: 'user', content: 'Hola, soy Karla Mendoza, tengo una clínica estética en Tijuana, aplicamos bótox y nos escriben por Instagram todo el día.' },
        ...slotOffered.slice(1),
        { role: 'user', content: 'Sí, ese me queda bien' },
      ],
      { requestContext: rc() },
    );

    expect(reply(res)).not.toMatch(ASKS_NAME);
    expect(toolIds(res)).toContain('bookAppointment');
    expect(String(toolArgs(res, 'bookAppointment')?.contactName ?? '').toLowerCase()).toContain('karla');
  });
});
