/**
 * Dr. Heriberto Valdivia — láser CO₂, anuncios de cierre con la oferta en la imagen (2026-10-08):
 * C10 "22%" (`lc10`), C11 "ahorro de $3,000" (`lc11`), C12 "bonos incluidos" (`lc12`). Cortados de
 * `lc7` (misma sección de cierre), cambia sólo el ángulo de entrada. El primer mensaje tiene que
 * decir lo que prometió el anuncio, sin perder las reglas de la oferta:
 *  - el precio normal $4,500 y el especial $3,500, con la condición de los 14 días;
 *  - la evaluación de $500, que se acredita — nunca "gratis", ni siquiera en C12, que la lista
 *    entre los bonos;
 *  - C11: los $3,000 de ahorro son un EJEMPLO de 3 sesiones, no una garantía;
 *  - C12: el kit con su valor de $1,500 y el seguimiento.
 *
 * `HNC_RED=1` corre los mismos mensajes con la conversación fijada en `lc7` (el ángulo del anuncio
 * "Precio especial", que no conoce el 22%, el ahorro ni los bonos): el lado rojo de cada caso.
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
import { buildAgentRequestContext } from '../../../core/runtime-context.js';
import type { TenantContext, TurnContext } from '../../../core/types.js';
import { HERIBERTO_LASER_CIERRE, heribertoTenant } from './fixtures.js';
import { evalApiKey, evalModel, evalProvider } from './eval-model.js';

const RED = process.env.HNC_RED === '1';

const tenant: TenantContext = {
  ...heribertoTenant,
  config: { ...heribertoTenant.config, promptVariants: HERIBERTO_LASER_CIERRE },
};

const run = async (variant: string, opener: string) => {
  const pinned = RED ? 'lc7' : variant;
  const turn: TurnContext = {
    ghlConversationId: `conv_eval_${variant}`,
    ghlContactId: `contact_eval_${variant}`,
    contactPhone: '+526141234567',
    channel: 'whatsapp',
    promptVariant: pinned,
  };
  const res = await buildFrontDeskAgent().generate([{ role: 'user', content: opener }], {
    requestContext: buildAgentRequestContext({ tenant, turn, provider: evalProvider, model: evalModel, llmApiKey: evalApiKey }),
  });
  if (process.env.EVAL_DEBUG) console.log(`[eval ${pinned}]`, res.text);
  return res.text.trim();
};

/** What every closing-ad opener owes, whatever the angle. */
const expectTheOffer = (text: string) => {
  expect(text).toMatch(/4,?500/);
  expect(text).toMatch(/3,?500/);
  expect(text).toMatch(/14 d[ií]as/);
  expect(text).toMatch(/\$\s?500\b/);
  expect(text).not.toMatch(/gratis|sin costo|de cortes[ií]a|2,?999/i);
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(q.logBotEvent).mockResolvedValue(undefined);
  vi.mocked(q.getActiveDemoSession).mockResolvedValue(null);
  getAvailability.mockResolvedValue([]);
});

describe.skipIf(!evalApiKey)(`Heriberto — láser, anuncios de cierre C10–C12 (${RED ? 'fijados en lc7 = lado rojo' : 'su variante'})`, () => {
  it('C10 "22%": confirma que aplica a TODAS las sesiones, con la condición', async () => {
    const text = await run('lc10', 'Hola, quiero el 22% en mi tratamiento de láser CO2');
    expectTheOffer(text);
    expect(text).toMatch(/22\s?%/);
    expect(text).toMatch(/todas/i);
  });

  it('C11 "ahorro": los $3,000 como ejemplo de 3 sesiones, no como promesa', async () => {
    const text = await run('lc11', 'Hola, quiero ahorrar en mi tratamiento de láser CO2');
    expectTheOffer(text);
    expect(text).toMatch(/3,?000/);
    expect(text).toMatch(/por ejemplo|ejemplo|depende|define/i);
  });

  it('C12 "bonos": kit con valor de $1,500 y seguimiento — la evaluación con su precio', async () => {
    const text = await run('lc12', 'Hola, quiero el láser CO2 con bonos incluidos');
    expectTheOffer(text);
    expect(text).toMatch(/1,?500/);
    expect(text).toMatch(/kit/i);
    expect(text).toMatch(/seguimiento/i);
  });
});
