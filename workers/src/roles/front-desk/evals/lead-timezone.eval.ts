/**
 * Golden cases for the lead's timezone (0057) — The Bot Crew's own funnel.
 *
 * The calendar is in Tijuana and most leads are in Mexico City time (one hour ahead
 * in summer, two in winter). Before 0057 the bot offered "las 3" and the lead heard
 * 3 their time; calls were missed. The fix is mechanical — the tools render every
 * label in the lead's clock with a "hora de …" suffix — so what these cases pin is
 * the MODEL's half of the contract:
 *
 *   · it repeats the label as given, suffix included, and never re-converts;
 *   · when the lead names another city it calls setLeadTimezone with the place,
 *     instead of doing timezone math in prose;
 *   · when the lead is not located it asks for the city before offering hours.
 *
 * Mocks: GHL availability returns one fixed instant (18:00Z on a Thursday); the DB
 * is mocked wholesale. Nothing here touches a real calendar.
 *
 * What each case is worth (§6c), measured on `gpt-5.6-luna`, 2026-08-28, with the
 * prompt's "# Zona horaria del lead" section stubbed out vs. present (3 runs each):
 *
 *   · ask-the-city: a REPRODUCTION — 0/3 without the section (the model called
 *     getAvailability and offered the Tijuana hour to an unlocated lead), 3/3 with it.
 *   · suffix repeated / setLeadTimezone called: GUARDS — 3/3 both ways. The label
 *     arrives from the tool already suffixed and the tool description alone is enough
 *     for the model to reach for it, so these pin behaviour the mechanics already
 *     produce. Kept because that is exactly the contract a later prompt edit could
 *     break ("resume the slots in your own words" would drop the suffix).
 *
 * One flake on the green side before a tool fix: the lead's "clínica en Polanco" made
 * the model call setLeadTimezone("Polanco") — right instinct, unmapped neighbourhood —
 * and the tool's "ask the state" reply stalled the turn (1 of 3). The tool now keeps
 * the zone on file when the place is unknown; 6/6 green since.
 *
 * Live-only (needs an API key); `pnpm eval`, excluded from the CI gate.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../db/queries.js');
const ghl = {
  addContactTags: vi.fn().mockResolvedValue(undefined),
  // 18:00Z = 11:00 a.m. Tijuana, 12:00 p.m. Mexico City, 1:00 p.m. Cancún.
  getAvailability: vi.fn().mockResolvedValue([{ start: '2026-09-03T18:00:00.000Z', end: '2026-09-03T18:20:00.000Z' }]),
};
vi.mock('../../../ghl/client.js', () => ({ GhlClient: vi.fn(() => ghl) }));

import * as q from '../../../db/queries.js';
import { buildFrontDeskAgent } from '../agent.js';
import { buildAgentRequestContext } from '../../../core/runtime-context.js';
import type { TenantContext, TurnContext } from '../../../core/types.js';
import { botCrewTenant } from './fixtures.js';
import { evalApiKey, evalModel, evalProvider } from './eval-model.js';

const remoteTenant: TenantContext = {
  ...botCrewTenant,
  config: { ...botCrewTenant.config, leadTimezoneEnabled: true },
};

const turnFor = (leadTimezone?: string): TurnContext => ({
  ghlConversationId: 'conv_eval_tz',
  ghlContactId: 'contact_eval_tz',
  contactPhone: '+5215512345678',
  channel: 'whatsapp',
  leadTimezone,
});

const rc = (leadTimezone?: string) =>
  buildAgentRequestContext({ tenant: remoteTenant, turn: turnFor(leadTimezone), provider: evalProvider, model: evalModel, llmApiKey: evalApiKey });

type ToolCallChunkLike = { payload: { toolName: string; args?: unknown } };
const toolIds = (res: { toolCalls?: ToolCallChunkLike[] }) => (res.toolCalls ?? []).map((c) => c.payload.toolName);
const toolArgs = (res: { toolCalls?: ToolCallChunkLike[] }, name: string) =>
  (res.toolCalls ?? []).find((c) => c.payload.toolName === name)?.payload.args as Record<string, unknown> | undefined;
const reply = (res: { text: string }) => res.text.toLowerCase();

// A lead who has already passed the fit filter and is asking for a time — the shape
// where availability gets offered.
const qualifiedHistory = [
  { role: 'user' as const, content: 'Hola, tengo una clínica estética en Polanco, aplicamos bótox y nos escriben por WhatsApp e Instagram todo el día.' },
  { role: 'assistant' as const, content: 'Perfecto, sí les puede servir. En una videollamada de 20 minutos, Leo te muestra el sistema funcionando con el caso de tu clínica. ¿Te aparto un espacio con Leo?' },
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(q.logBotEvent).mockResolvedValue(undefined);
  vi.mocked(q.setLeadTimezone).mockResolvedValue(true);
  ghl.getAvailability.mockResolvedValue([{ start: '2026-09-03T18:00:00.000Z', end: '2026-09-03T18:20:00.000Z' }]);
});

describe.skipIf(!evalApiKey)('lead timezone — the label is the contract', () => {
  it('offers the slot in the lead\'s clock, suffix included, and never the calendar\'s hour', async () => {
    const agent = buildFrontDeskAgent();
    const res = await agent.generate(
      [...qualifiedHistory, { role: 'user', content: 'Sí, ¿qué horarios tienes el jueves?' }],
      { requestContext: rc('America/Mexico_City') },
    );

    expect(toolIds(res)).toContain('getAvailability');
    // 12:00 p.m. hora de Ciudad de México — not 11:00 (Tijuana), and not unlabelled.
    expect(reply(res)).toMatch(/12(:00)?\s*(p\.?\s?m\.?|del d[ií]a|del mediod[ií]a|mediod[ií]a)/);
    expect(reply(res)).toContain('hora de ciudad de méxico');
    expect(reply(res)).not.toMatch(/\b11(:00)?\s*(a\.?\s?m\.?|de la mañana)/);
    expect(reply(res)).not.toMatch(/tijuana/);
  });

  it('when the lead names another city, it calls setLeadTimezone instead of converting in prose', async () => {
    const agent = buildFrontDeskAgent();
    const res = await agent.generate(
      [
        ...qualifiedHistory,
        { role: 'assistant', content: 'Tengo el jueves 3 de septiembre a las 12:00 p.m. hora de Ciudad de México. ¿Te lo aparto?' },
        { role: 'user', content: 'Ah, es que yo estoy en Cancún' },
      ],
      { requestContext: rc('America/Mexico_City') },
    );

    expect(toolIds(res)).toContain('setLeadTimezone');
    expect(String(toolArgs(res, 'setLeadTimezone')?.place ?? '').toLowerCase()).toContain('canc');
    // After the tool, the re-rendered label is 1:00 p.m. hora de Cancún — the model must
    // not narrate arithmetic ("una hora más", "sería la 1 allá") in place of the label.
    expect(reply(res)).not.toMatch(/una hora (más|menos|de diferencia)|sum(a|ar)|rest(a|ar)/);
  });

  it('with the lead not located, it asks for the city before offering hours', async () => {
    const agent = buildFrontDeskAgent();
    const res = await agent.generate(
      [...qualifiedHistory, { role: 'user', content: 'Sí, ¿qué horarios tienes?' }],
      { requestContext: rc(undefined) },
    );

    expect(reply(res)).toMatch(/ciudad|d[oó]nde (est[aá]s|se encuentran|est[aá]n)|de d[oó]nde/);
    expect(toolIds(res)).not.toContain('getAvailability');
    expect(reply(res)).not.toMatch(/\d{1,2}(:\d{2})?\s*(a\.?\s?m|p\.?\s?m)/);
  });
});
