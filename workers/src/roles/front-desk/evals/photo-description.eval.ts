/**
 * A lead's photo reaches the model as a description line — golden cases for what the
 * agent does with it (`core/describe-image.ts` + the "# Fotos del lead" prompt section).
 *
 * The incident (Dr. Heriberto Valdivia, 2026-09-02, WhatsApp): a lead asked for bótox "en
 * la parte baja de la cara como los lados por la barbilla", the bot asked whether she
 * meant the maseteros, and she answered with two photos of her marionette lines. The
 * store kept "[imagen]" and the model saw exactly that, so it answered twice "no alcanzo
 * a distinguir la zona" and Leo had to switch the bot off and write the answer by hand:
 * líneas de marioneta → se valora ácido hialurónico ($5,500) → el doctor la evalúa.
 *
 * Images are now described at ingest and the description replaces the placeholder. What
 * these cases defend is the PROMPT side: with the description in front of it the model
 * must name the zone and the treatment from the tenant's list, and must never say it
 * cannot see images. The rule lives in code (prompt.ts, not the tenant fixture), so the
 * red side is measured by emptying `photoSection` locally — never committed that way.
 *
 *   MEDIDO en gpt-5.6-luna, 2026-09-02 (corridas seriadas, hilo real del incidente):
 *   - foto descrita (marioneta): con sección 3/3 · sin sección 1/3. Sin la sección el modelo
 *     NO dice "no alcanzo a ver" (la descripción sola ya cura eso): las dos fallas son la
 *     misma respuesta, nombra las líneas y se queda en "¿son esas líneas?" — nunca llega al
 *     ácido hialurónico ni al precio. La sección es lo que convierte "vi la zona" en el paso
 *     siguiente del flujo (tratamiento de la lista + valoración del doctor).
 *   - foto borrosa:              con sección 3/3 · sin sección 3/3 — no discrimina; queda de guardia.
 *   - "[imagen]" sin resolver:   con sección 3/3 · sin sección 2/3. La falla sin sección es
 *     la peor: ignora la foto y contesta la pregunta anterior con precio ("el bótox en
 *     maseteros cuesta $3,500") — le pone precio a una zona que la lead no confirmó.
 *
 * Live cases need an API key (`pnpm eval`); excluded from the CI gate.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../db/queries.js');
vi.mock('../../../ghl/client.js', () => ({
  GhlClient: vi.fn(() => ({
    getAvailability: vi.fn().mockResolvedValue([]),
    addContactTags: vi.fn().mockResolvedValue(undefined),
  })),
}));

import * as q from '../../../db/queries.js';
import { buildFrontDeskAgent } from '../agent.js';
import { buildAgentRequestContext } from '../../../core/runtime-context.js';
import { PHOTO_DESCRIPTION_PREFIX } from '../../../core/model-messages.js';
import type { TenantContext, TurnContext } from '../../../core/types.js';
import { heribertoTenant } from './fixtures.js';
import { evalApiKey, evalModel, evalProvider } from './eval-model.js';

const turn: TurnContext = {
  ghlConversationId: 'conv_eval_photo',
  ghlContactId: 'contact_eval_photo',
  contactPhone: '+526141234567',
  channel: 'whatsapp',
};
const rc = (tenant: TenantContext) =>
  buildAgentRequestContext({ tenant, turn, provider: evalProvider, model: evalModel, llmApiKey: evalApiKey });

type ToolCallChunkLike = { payload: { toolName: string } };
const toolIds = (res: { toolCalls?: ToolCallChunkLike[] }): string[] => (res.toolCalls ?? []).map((c) => c.payload.toolName);
const reply = (res: { text: string }) => res.text.trim().toLowerCase();

/** The real thread, verbatim, up to the photo. */
const THREAD = [
  { role: 'user' as const, content: 'PRIMERA VEZ' },
  { role: 'assistant' as const, content: '¡Hola! Soy Sofía, del consultorio del Dr. Heriberto Valdivia. Si es tu primera vez, es totalmente normal tener dudas: la cita incluye valoración y un plan personalizado con el doctor, y la aplicación puede hacerse ese mismo día si determina que es adecuado para ti, sin compromiso. ¿Qué te gustaría mejorar?' },
  { role: 'user' as const, content: 'Cual es el costo por aplicación de botox' },
  { role: 'assistant' as const, content: 'El bótox se cobra por zona:\nFrente $2,500, entrecejo $2,000, patas de gallo $2,000, maseteros $3,500 y full face —frente, entrecejo y patas de gallo— $6,000.\nLa cita incluye valoración y aplicación el mismo día si el doctor determina que es adecuado para ti. ¿Te interesa una zona específica o full face?' },
  { role: 'user' as const, content: 'Me gustaría en la parte baja de la cara como los lados por la barbilla' },
  { role: 'assistant' as const, content: '¿Te refieres a los maseteros, en los lados de la mandíbula, o a otra zona?' },
];

const MARIONETTE = `${PHOTO_DESCRIPTION_PREFIX} Primer plano de la parte baja del rostro, de frente. Se ven los surcos que bajan de las comisuras de los labios hacia la barbilla, a ambos lados (líneas de marioneta). No señala nada con el dedo ni hay marcas en la foto.]`;
const BLURRY = `${PHOTO_DESCRIPTION_PREFIX} Foto borrosa y con poca luz de una parte del rostro; no se distingue qué zona es ni qué quiere señalar.]`;

/** The failure the incident produced, in every wording the model reached for. */
const CANNOT_SEE = /no (alcanzo|puedo|logro) (a )?(ver|distinguir)|no (veo|distingo) (bien )?(la|tu) (foto|imagen)|no puedo ver im[aá]genes|vu[eé]lve(la)? a (mandar|enviar)|m[aá]ndame (otra|de nuevo) (foto|imagen)/;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(q.logBotEvent).mockResolvedValue(undefined);
  vi.mocked(q.getActiveDemoSession).mockResolvedValue(null);
});

describe.skipIf(!evalApiKey)('Fotos del lead — la descripción cuenta como vista', () => {
  it('líneas de marioneta descritas → nombra la zona, ofrece ácido hialurónico con su precio, nunca "no alcanzo a ver"', async () => {
    const res = await buildFrontDeskAgent().generate([...THREAD, { role: 'user', content: MARIONETTE }], {
      requestContext: rc(heribertoTenant),
    });
    const text = reply(res);
    expect(text, text).not.toMatch(CANNOT_SEE);
    expect(text, text).toMatch(/marioneta|comisuras/);
    // The house rule for a zone outside the bótox list: name the treatment that serves it,
    // with its price, and leave "whether it's right for her" to the doctor.
    expect(text, text).toMatch(/hialur[oó]nico/);
    expect(text, text).toMatch(/5,?500/);
    expect(toolIds(res)).not.toContain('flagPendingInfo');
  }, 120_000);

  it('foto borrosa → pide la zona con palabras, sin precio y sin pedir otra foto', async () => {
    const res = await buildFrontDeskAgent().generate([...THREAD, { role: 'user', content: BLURRY }], {
      requestContext: rc(heribertoTenant),
    });
    const text = reply(res);
    expect(text, text).toMatch(/\?/);
    expect(text, text).not.toMatch(/\$\s?\d/);
    expect(text, text).not.toMatch(/vu[eé]lve(la)? a (mandar|enviar)|m[aá]ndame (otra|de nuevo)/);
  }, 120_000);

  it('"[imagen]" sin resolver → agradece y pregunta qué quiso mostrar, sin inventar lo que había en la foto', async () => {
    const res = await buildFrontDeskAgent().generate([...THREAD, { role: 'user', content: '[imagen]' }], {
      requestContext: rc(heribertoTenant),
    });
    const text = reply(res);
    expect(text, text).toMatch(/\?/);
    expect(text, text).not.toMatch(/marioneta|hialur[oó]nico|\$\s?\d/);
  }, 120_000);
});
