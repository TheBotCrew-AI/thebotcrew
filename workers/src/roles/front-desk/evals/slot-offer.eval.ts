/**
 * Cómo Sara ofrece los horarios de la llamada con Leo.
 *
 * El calendario abre a las 6:00 a.m., así que "los tres más próximos" son 6:00, 6:15 y
 * 6:30 — que es literalmente lo que le ofreció al primer lead real (Heriberto, 2026-08-27,
 * conv UL6egbxUoIy3IbPWLroS), y contestó "Es lo único que tienes". La regla nueva vive en
 * `toolInstructions.getAvailability` del tenant: DOS horarios que contrasten, uno de la
 * mañana de las 9:00 en adelante y uno de la tarde.
 *
 * La lista de slots es la que GHL devolvió en ESE turno (evento availability_checked),
 * anclada a un día fijo: es el caso real que motivó la regla.
 *
 * MEDIDO en gpt-5.6-luna, 2026-08-27: verde 3/3. Lado rojo — con la instrucción anterior
 * ("Ofrece máximo 3 horarios usando su label tal cual") restaurada: 0/3. Discrimina, y lo
 * que falla es la hora, no la cantidad: las tres corridas ofrecieron dos horarios pero
 * empezando de madrugada. Por eso la aserción que manda es la de las 9:00, no el conteo.
 *
 * Live-only (necesita API key), excluido del gate de CI.
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
import { buildAgentRequestContext } from '../../../core/runtime-context.js';
import type { TurnContext } from '../../../core/types.js';
import { botCrewTenant } from './fixtures.js';
import { evalApiKey, evalModel, evalProvider } from './eval-model.js';

const turn: TurnContext = {
  ghlConversationId: 'conv_eval_slots',
  ghlContactId: 'contact_eval_slots',
  channel: 'whatsapp',
};

const rc = () =>
  buildAgentRequestContext({ tenant: botCrewTenant, turn, provider: evalProvider, model: evalModel, llmApiKey: evalApiKey });

/**
 * El día del calendario de Leo tal como GHL lo devolvió: cada 15 min de 6:00 a 8:30,
 * hueco, 11:30 a 2:30, hueco, y 4:00 a 5:30. Fechado hacia adelante para que nunca
 * quede en el pasado (el tool recorta el rango contra "ahora").
 */
const DAY = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
const times = [
  ...['06:00', '06:15', '06:30', '06:45', '07:00', '07:15', '07:30', '07:45', '08:00', '08:15', '08:30'],
  ...['11:30', '11:45', '12:00', '12:15', '12:30', '12:45', '13:00', '13:15', '13:30', '13:45', '14:00', '14:15', '14:30'],
  ...['16:00', '16:15', '16:30', '16:45', '17:00', '17:15', '17:30'],
];
const SLOTS = times.map((t) => ({
  start: `${DAY}T${t}:00-07:00`,
  end: `${DAY}T${t}:00-07:00`,
}));

const reply = (res: { text: string }) => res.text.trim();

/**
 * Las horas (en formato 24h del slot) que la respuesta realmente menciona.
 * El dígito anterior tiene que NO ser un dígito: sin eso, "1:30" casa dentro de
 * "11:30" y una respuesta con dos horarios se cuenta como tres.
 */
const offered = (text: string): string[] =>
  times.filter((t) => {
    const [h, m] = t.split(':').map(Number) as [number, number];
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return new RegExp(`(?<!\\d)${h12}:${String(m).padStart(2, '0')}`).test(text);
  });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(q.logBotEvent).mockResolvedValue(undefined);
  getAvailability.mockResolvedValue(SLOTS);
});

describe.skipIf(!evalApiKey)('horarios — dos que contrasten, nunca las 6 de la mañana', () => {
  it('ofrece uno de la mañana y uno de la tarde, ninguno antes de las 9:00', async () => {
    const agent = buildFrontDeskAgent();
    const res = await agent.generate(
      [
        { role: 'assistant', content: 'En una videollamada de 20 minutos, Leo te muestra el sistema funcionando con el caso de tu clínica.\n\n¿Te aparto un espacio con él?' },
        { role: 'user', content: 'Si' },
      ],
      { requestContext: rc() },
    );

    const hours = offered(reply(res));
    // Dos horarios, no tres ni la lista entera.
    expect(hours.length).toBe(2);
    // Ninguno de madrugada: es la queja textual del primer lead real.
    expect(hours.every((t) => Number(t.split(':')[0]) >= 9)).toBe(true);
    // Uno de cada franja.
    expect(hours.some((t) => Number(t.split(':')[0]) < 12)).toBe(true);
    expect(hours.some((t) => Number(t.split(':')[0]) >= 12)).toBe(true);
  }, 120_000);
});
