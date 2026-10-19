/**
 * Lista de espera — el lead no puede dentro de la ventana de agenda.
 *
 * Heriberto abre agenda 7 días por adelantado (`booking_horizon_days = 7`). Hasta hoy, cuando
 * un lead decía "no puedo esta semana, hasta noviembre", la regla del horizonte terminaba en
 * "ofrécele el horario más pronto disponible": el bot repetía los mismos horarios y la lead
 * se iba. Leo (2026-10-19): que lo entienda, que explique que la agenda se abre una semana
 * antes, que le ofrezca la lista de espera y pregunte qué día le acomoda; cuando lo diga, la
 * anota (flagAwaitingHuman) para que una persona la agende cuando se abra la fecha.
 *
 * Tres casos:
 *   1. "no puedo esta semana, ando fuera" (sin fecha) → entiende + lista de espera + pregunta el
 *      día. NO llama flagAwaitingHuman (termina en pregunta) ni reofrece los mismos horarios.
 *   2. "el martes 3 por la tarde" (turno siguiente) → la anota: flagAwaitingHuman con la fecha;
 *      NO getAvailability.
 *   3. "hasta el 3 de noviembre regreso" (fecha en el mismo mensaje) → anota de una vez, sin
 *      preguntar de nuevo. Salió solo en la primera corrida verde y se volvió regla.
 *
 * MEDIDO 2026-10-19 (gpt-6-luna, high, 3 corridas por lado; rojo = el prompt sin las viñetas
 * de lista de espera, `git stash` del cambio): verde 9/9 · rojo 0/9. Las nueve rojas caen en
 * dos formas: reofrecer los mismos horarios de esta semana ("los espacios que me aparecen
 * son martes 20…") o soltar a la lead ("escríbeme cuando regreses y con gusto reviso"). Una
 * roja además llamó updateConversationStatus: la dio por cerrada.
 *
 * El "ahora" está clavado en lunes 19 de octubre de 2026, 12:00 en Chihuahua: la ventana
 * llega al lunes 26 y "el 3 de noviembre" queda siempre fuera.
 *
 * Live-only (needs an API key); `pnpm eval`, excluded from the CI gate.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
import { buildAgentRequestContext } from '../../../core/runtime-context.js';
import type { TurnContext } from '../../../core/types.js';
import { heribertoTenant } from './fixtures.js';
import { evalApiKey, evalModel, evalProvider } from './eval-model.js';

/** Lunes 19 de octubre de 2026, 12:00 en Chihuahua. Ventana de 7 días: hasta el lunes 26. */
const NOW = Date.parse('2026-10-19T18:00:00Z');
const SLOTS = ['2026-10-20T15:45:00-06:00', '2026-10-20T17:15:00-06:00'].map((start) => ({ start, end: start }));

const turn: TurnContext = {
  ghlConversationId: 'conv_eval_waitlist',
  ghlContactId: 'contact_eval_waitlist',
  contactPhone: '+526141234567',
  channel: 'whatsapp',
};

const rc = () =>
  buildAgentRequestContext({ tenant: heribertoTenant, turn, provider: evalProvider, model: evalModel, llmApiKey: evalApiKey });

type ToolCallChunkLike = { payload: { toolName: string; args?: unknown } };
const calls = (res: { toolCalls?: ToolCallChunkLike[] }) => res.toolCalls ?? [];
const toolIds = (res: { toolCalls?: ToolCallChunkLike[] }): string[] => calls(res).map((c) => c.payload.toolName);

const OPENING = [
  { role: 'user' as const, content: 'Hola, quiero agendar valoración para láser' },
  {
    role: 'assistant' as const,
    content:
      '¡Hola! Soy Sofía, del consultorio del Dr. Heriberto Valdivia 😊 La valoración es sin costo. Tengo el martes, 20 de octubre, 3:45 p.m. o martes, 20 de octubre, 5:15 p.m., ¿cuál te acomoda?',
  },
];
const NO_DATE = [...OPENING, { role: 'user' as const, content: 'No puedo esta semana, ando fuera de la ciudad' }];
const WITH_DATE = [...OPENING, { role: 'user' as const, content: 'No puedo esta semana, ando fuera. Hasta el 3 de noviembre regreso' }];

const WAITLIST = /lista de espera/;
const UNDERSTANDS = /entiendo|claro|sin problema|no te preocupes|comprendo/;
const ASKS_DAY = /qu[ée] d[íi]a|qu[ée] fecha|cu[áa]l d[íi]a|qu[ée] semana/;
const REOFFERS_THIS_WEEK = /3:45|5:15|martes,? 20/;

let nowSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(q.logBotEvent).mockResolvedValue(undefined);
  vi.mocked(q.getActiveDemoSession).mockResolvedValue(null);
  vi.mocked(q.updateConversationStatus).mockResolvedValue(true);
  getAvailability.mockResolvedValue(SLOTS);
  nowSpy = vi.spyOn(Date, 'now').mockReturnValue(NOW);
});
afterEach(() => nowSpy.mockRestore());

describe.skipIf(!evalApiKey)('lista de espera — el lead no puede dentro de la ventana', () => {
  it('"ando fuera de la ciudad" (sin fecha) → entiende, explica la ventana, ofrece lista de espera y pregunta el día', async () => {
    const res = await buildFrontDeskAgent().generate(NO_DATE, { requestContext: rc() });
    const text = res.text.toLowerCase();
    if (process.env.EVAL_DEBUG) console.log('[eval waitlist 1]', res.text, toolIds(res));
    expect(text, text).toMatch(WAITLIST);
    expect(text, text).toMatch(UNDERSTANDS);
    expect(text, text).toMatch(ASKS_DAY);
    expect(text, text).not.toMatch(REOFFERS_THIS_WEEK);
    expect(toolIds(res), text).not.toContain('flagAwaitingHuman');
  }, 120_000);

  it('"el martes 3 por la tarde" → la anota con flagAwaitingHuman, sin consultar la agenda', async () => {
    const res = await buildFrontDeskAgent().generate(
      [
        ...NO_DATE,
        {
          role: 'assistant',
          content:
            'Entiendo totalmente 😊 La agenda se abre solo 7 días por adelantado, pero con mucho gusto te anoto en la lista de espera para tu fecha. ¿Qué día te acomodaría mejor?',
        },
        { role: 'user', content: 'El martes 3 de noviembre por la tarde' },
      ],
      { requestContext: rc() },
    );
    const text = res.text.toLowerCase();
    if (process.env.EVAL_DEBUG) console.log('[eval waitlist 2]', res.text, JSON.stringify(calls(res).map((c) => c.payload)));
    expect(toolIds(res), text).toContain('flagAwaitingHuman');
    expect(toolIds(res), text).not.toContain('getAvailability');
    const flag = calls(res).find((c) => c.payload.toolName === 'flagAwaitingHuman');
    expect(JSON.stringify(flag?.payload.args ?? {}).toLowerCase()).toMatch(/3 de noviembre|martes 3|noviembre/);
    expect((flag?.payload.args as { waitlistDate?: string } | undefined)?.waitlistDate, text).toBe('2026-11-03');
    expect(text, text).not.toMatch(REOFFERS_THIS_WEEK);
  }, 120_000);

  it('"hasta el 3 de noviembre regreso" (fecha en el mismo mensaje) → la anota de una vez, sin preguntar el día', async () => {
    const res = await buildFrontDeskAgent().generate(WITH_DATE, { requestContext: rc() });
    const text = res.text.toLowerCase();
    if (process.env.EVAL_DEBUG) console.log('[eval waitlist 3]', res.text, toolIds(res));
    expect(toolIds(res), text).toContain('flagAwaitingHuman');
    expect(toolIds(res), text).not.toContain('getAvailability');
    expect(text, text).not.toMatch(REOFFERS_THIS_WEEK);
  }, 120_000);
});
