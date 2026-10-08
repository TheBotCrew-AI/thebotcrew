/**
 * Horario preferente (0066): la tarde es para quien paga; la valoración gratis la recibe
 * solo cuando de plano no puede en otro horario.
 *
 * La mitad determinista (esconder los slots prime, soltarlos con includePrimeTime, rechazar
 * la reserva sin el evento) vive en los tools y se prueba en sus `*.test.ts`. Lo que defiende
 * ESTE archivo es la mitad que es tasa: que el modelo (1) pida los horarios escondidos solo
 * cuando el lead ya rechazó el resto y no en la primera consulta, y (2) no delate la regla —
 * ni "ocupada" para la hora escondida, ni "excepción" al soltarla.
 *
 * Tenant sintético (Clínica Aura, el mismo del demo `pnpm battery prime-time-demo`): nadie
 * lo tiene prendido en prod, así que no hay fixture que mirar ni drift que vigilar.
 *
 * MEDIDO en gpt-5.6-luna, 2026-10-08 (corridas seriadas), los dos casos:
 *  - con todo: 3/3.
 *  - sin la sección `# Horario preferente` del prompt (tool intacto): 3/3 también. Las notas
 *    del tool ("NO debes mencionar", "vuelve a llamar con includePrimeTime: true") bastan
 *    para este modelo; la sección es GUARDIA para el turno donde el modelo contesta sin
 *    consultar y para las palabras ("ocupada", "excepción"), no la prueba de nada.
 *  - sin el filtro del tool no hay lado rojo que medir: el caso 1 cae en seco porque la
 *    tarde vuelve a la lista. Esa mitad es determinista y vive en `tools/*.test.ts`.
 *
 * Live-only (necesita API key), excluido del gate de CI.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
import { buildAgentRequestContext } from '../../../core/runtime-context.js';
import type { TurnContext } from '../../../core/types.js';
import { primeTimeDemoTenant } from '../../../battery/scenarios/prime-time-demo.js';
import { evalApiKey, evalModel, evalProvider } from './eval-model.js';

/** Martes 6 de octubre de 2026, 9:00 en la Ciudad de México. */
const NOW = Date.parse('2026-10-06T15:00:00Z');
const WED = '2026-10-07';
const THU = '2026-10-08';
/** Mañana y tarde del miércoles y jueves; 5–8 p.m. es horario preferente. */
const SLOTS = [
  `${WED}T10:00`, `${WED}T12:30`, `${WED}T16:30`, `${WED}T18:00`, `${WED}T19:00`,
  `${THU}T11:00`, `${THU}T16:30`, `${THU}T18:30`,
].map((t) => ({ start: `${t}:00-06:00`, end: `${t}:00-06:00` }));

const turn: TurnContext = { ghlConversationId: 'conv_eval_prime', ghlContactId: 'contact_eval_prime', channel: 'whatsapp', contactPhone: '+525512345678' };
const rc = () => buildAgentRequestContext({ tenant: primeTimeDemoTenant, turn, provider: evalProvider, model: evalModel, llmApiKey: evalApiKey });
const reply = (res: { text: string }) => res.text.trim().toLowerCase();
type Call = { payload: { toolName: string; args?: unknown } };
const primeArg = (c: Call) => (c.payload.args as { includePrimeTime?: boolean } | undefined)?.includePrimeTime;
const availabilityCalls = (res: { toolCalls?: Call[] }) => (res.toolCalls ?? []).filter((c) => c.payload.toolName === 'getAvailability');

/** La regla, delatada: la hora escondida como "ocupada", o la liberación como favor. */
const LEAKS = /ocupad|tomad|preferente|excepci[óo]n|favor|reservad[oa]s? para|servicios? (?:de )?pag/;
/** Una hora de la tarde (5–8 p.m.) en el texto. */
const EVENING = /\b(?:5|6|7):[0-5]\d\s*p\.?\s?m\.|\b(?:17|18|19):[0-5]\d/;

let nowSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(q.logBotEvent).mockResolvedValue(undefined);
  vi.mocked(q.getActiveDemoSession).mockResolvedValue(null);
  vi.mocked(q.wasPrimeTimeReleased).mockResolvedValue(false);
  getAvailability.mockResolvedValue(SLOTS);
  nowSpy = vi.spyOn(Date, 'now').mockReturnValue(NOW);
});
afterEach(() => nowSpy.mockRestore());

describe.skipIf(!evalApiKey)('horario preferente — la valoración gratis', () => {
  it('"¿tienen a las 6?" en la primera consulta → sin includePrimeTime, sin tarde, sin "ocupada"', async () => {
    const res = await buildFrontDeskAgent().generate(
      [{ role: 'user', content: 'Hola! Quiero agendar la valoración gratuita, ¿tienen algo a las 6 de la tarde?' }],
      { requestContext: rc() },
    );
    const calls = availabilityCalls(res);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => primeArg(c) !== true)).toBe(true);
    const text = reply(res);
    expect(text).not.toMatch(EVENING);
    expect(text).not.toMatch(LEAKS);
  }, 120_000);

  it('"de plano solo puedo de 6 en adelante" → includePrimeTime: true, ofrece la tarde, sin delatar', async () => {
    const res = await buildFrontDeskAgent().generate(
      [
        { role: 'user', content: 'Hola! Quiero agendar la valoración gratuita, ¿tienen algo a las 6 de la tarde?' },
        {
          role: 'assistant',
          content: 'Qué bueno que me escribes. Lo más próximo que te puedo apartar es miércoles, 7 de octubre, 4:30 p.m. o jueves, 8 de octubre, 4:30 p.m. ¿Cuál te acomoda mejor?',
        },
        { role: 'user', content: 'No puedo en esos horarios, trabajo y de plano solo puedo de 6 de la tarde en adelante.' },
      ],
      { requestContext: rc() },
    );
    const calls = availabilityCalls(res);
    expect(calls.some((c) => primeArg(c) === true)).toBe(true);
    const text = reply(res);
    expect(text).toMatch(EVENING);
    expect(text).not.toMatch(LEAKS);
  }, 120_000);
});
