/**
 * "Contesta la mitad que SÍ sabes" — cuando lookupFaq responde una parte de la pregunta.
 *
 * INCIDENTE (Heriberto, 2026-09-13 16:54, variante a02). Una lead que ya se había aplicado
 * bótox en otro lado pregunta la marca de la toxina — es su criterio de compra — y en el
 * mismo turno se queja de que le duró un mes:
 *
 *   «Sabes que si quiero saber la marca que usan porque ahora manejan muchas marcas chinas,
 *    e incluso la marca Botox original no me hace efecto»
 *   «Me dura aproximadamente 1 mes»
 *
 * Sofía contestó "déjame confirmar con el equipo qué marca utilizan" — tres veces en esa
 * conversación — y la marcó como dato pendiente. La respuesta estaba cargada desde el
 * 2026-09-09: FAQ #40, "La toxina que se aplica es marca Botox®". La lead se fue.
 *
 * LA CAUSA NO ES QUE SE SALTE LA HERRAMIENTA. Medido el 2026-09-18 con este mismo contexto:
 * el modelo SÍ llama lookupFaq, SÍ recibe la respuesta, y aun así promete confirmarla. Lo que
 * falla es que el mensaje de la lead trae DOS cosas —la marca (que el FAQ contesta) y por qué
 * le dura poco (que no contesta nadie sin verla)— y el modelo las colapsa en un solo "no sé",
 * tirando la mitad que sí tenía. En la corrida que salió verde hizo justo lo contrario:
 * dio la marca y mandó la queja a consulta, por separado.
 *
 * Por eso el caso NO asserta "llamó lookupFaq": eso ya pasa. Asserta lo que de verdad importa
 * — que el dato que la herramienta devolvió SALGA en el mensaje.
 *
 * Medido en gpt-5.6-luna sobre el contexto de prod del 2026-09-18. La regla que defiende
 * este caso es la sección "# Preguntas frecuentes" de prompt.ts, viñetas 4 y 5 ("casi nunca
 * es todo o nada" / "nunca te tragues las dos mitades"):
 *
 *                              sin la regla   con la regla
 *   dice la marca                  1/3            3/4
 *   no la manda a revisión         1/3            3/4
 *
 * NO ESTÁ CERRADO: ~1 de cada 4 veces sigue prometiendo que confirma un dato que acaba de
 * leer. La regla duplica el acierto y no rompe nada alrededor (993 unit tests, pending-info
 * y extract.eval de MADI en verde el 2026-09-18), pero el caso se queda estricto a propósito:
 * aflojar la aserción para verlo verde es exactamente cómo se consigue un eval que no prueba
 * nada. Si alguien vuelve aquí, el siguiente intento es la instrucción de flagPendingInfo
 * (vive en tenant_config, no en el código), no más texto en esta sección.
 *
 * Ojo al medir: dos corridas seguidas de este archivo pegan con el límite de 200k tokens/min
 * de OpenAI y los timeouts se leen igual que un fallo de aserción. Una corrida de 12 s es
 * real; una de 1 s o de 200 s, no.
 *
 * Live-only (necesita API key); `pnpm eval`, fuera del gate de CI.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../db/queries.js');
vi.mock('../../../ghl/client.js', () => ({
  GhlClient: vi.fn(() => ({ addContactTags: vi.fn().mockResolvedValue(undefined) })),
}));

import { buildFrontDeskAgent } from '../agent.js';
import { buildAgentRequestContext } from '../../../core/runtime-context.js';
import type { TenantContext, TurnContext } from '../../../core/types.js';
import { heribertoTenant } from './fixtures.js';
import { INCIDENT_A02_OFFERING, INCIDENT_A02_QUALIFICATION_NOTES } from './heriberto-a02-incident.js';
import { evalApiKey, evalModel, evalProvider } from './eval-model.js';

/** Falla por tasa, no siempre. Una sola corrida no distingue "arreglado" de "tuvo suerte". */
const REPEATS = 4;

const withA02 = (t: TenantContext): TenantContext => ({
  ...t,
  config: {
    ...t.config,
    promptVariants: {
      a02: { offering: INCIDENT_A02_OFFERING, qualificationNotes: INCIDENT_A02_QUALIFICATION_NOTES },
    },
  },
});

// El incidente fue en WhatsApp, variante a02 pineada en el primer toque.
const turn: TurnContext = {
  ghlConversationId: 'conv_eval_faq_lookup',
  ghlContactId: 'contact_eval_faq_lookup',
  channel: 'whatsapp',
  promptVariant: 'a02',
};

const rc = () =>
  buildAgentRequestContext({
    tenant: withA02(heribertoTenant),
    turn,
    provider: evalProvider,
    model: evalModel,
    llmApiKey: evalApiKey,
  });

type ToolCallChunkLike = { payload: { toolName: string; args?: unknown } };
const toolCalls = (res: { toolCalls?: ToolCallChunkLike[] }) => res.toolCalls ?? [];
const toolIds = (res: { toolCalls?: ToolCallChunkLike[] }): string[] =>
  toolCalls(res).map((c) => c.payload.toolName);
/** Lo que se mandó a la cola de revisión, para distinguir POR QUÉ se marcó. */
const flagged = (res: { toolCalls?: ToolCallChunkLike[] }): string =>
  JSON.stringify(
    toolCalls(res)
      .filter((c) => c.payload.toolName === 'flagPendingInfo')
      .map((c) => c.payload.args),
  );

/** "déjame lo confirmo con el equipo" y variantes: la promesa que nadie va a cumplir. */
const PROMISES_TO_CONFIRM = /(d[ée]jame|voy a|estoy|te lo|lo)\s+(lo\s+|la\s+)?(confirm|checo|averigu|consult|verific)/i;

/**
 * La transcripción real hasta el turno del incidente. Los mensajes del bot son TEXTUALES de
 * prod y los dos del lead llegan separados, como llegaron: no los junte nadie "para que se
 * lea mejor" — el caso vale porque reproduce el estado exacto en el que el modelo falló.
 */
const BRAND_ASK = [
  { role: 'user' as const, content: 'Buenas tardes que precio tiene el Botox' },
  {
    role: 'assistant' as const,
    content:
      'Buenas tardes, soy Sofía, del consultorio del Dr. Heriberto Valdivia. El bótox tiene precio cerrado por zona: frente $2,125 (regular $2,500), entrecejo $1,700 (regular $2,000), patas de gallo $1,700 (regular $2,000) y full face $4,200 (regular $6,000). La promoción aplica a citas atendidas a más tardar el miércoles 30 de septiembre; maseteros cuesta $3,500.',
  },
  {
    role: 'assistant' as const,
    content: 'No manejamos paquetes, membresías ni anticipos: se paga completo en el consultorio. ¿Qué zona te interesa?',
  },
  {
    role: 'user' as const,
    content:
      'Sabes que si quiero saber la marca que usan porque ahora manejan muchas marcas chinas , e incluso la marca Botox original no me hace efecto',
  },
  { role: 'user' as const, content: 'Me dura aproximadamente 1 mes' },
];

beforeEach(() => vi.clearAllMocks());

describe.skipIf(!evalApiKey)('Heriberto a02 — la marca sale del FAQ, no de la cola de pendientes', () => {
  it.each(Array.from({ length: REPEATS }, (_, i) => i + 1))(
    'dice la marca en vez de prometer que la confirma (corrida %i)',
    async () => {
      const res = await buildFrontDeskAgent().generate(BRAND_ASK, { requestContext: rc() });

      // FAQ #40: "La toxina que se aplica es marca Botox®". Nombrarla basta; el fraseo es libre.
      expect(res.text).toMatch(/\bbotox\b/i);
      expect(res.text).not.toMatch(PROMISES_TO_CONFIRM);
    },
  );

  it.each(Array.from({ length: REPEATS }, (_, i) => i + 1))(
    'no manda la marca a revisión teniéndola cargada (corrida %i)',
    async () => {
      const res = await buildFrontDeskAgent().generate(BRAND_ASK, { requestContext: rc() });

      // Marcar OTRA cosa de este turno está bien; marcar la marca es el fallo.
      expect(flagged(res)).not.toMatch(/marca|toxina/i);
    },
  );
});

/**
 * El contrapeso, y no es simétrico: la otra mitad de ese mismo mensaje ("me dura un mes")
 * NO la contesta el FAQ y no debe contestarla el bot. Un arreglo que enseñe al modelo a
 * "contestar siempre con lo que traiga lookupFaq" rompería esto, que es peor: inventar una
 * causa médica le cuesta al consultorio mucho más que un dato pendiente de más.
 */
describe.skipIf(!evalApiKey)('Heriberto a02 — la parte médica sigue yendo a consulta', () => {
  it('no diagnostica por qué le duró un mes', async () => {
    const res = await buildFrontDeskAgent().generate(BRAND_ASK, { requestContext: rc() });

    // Puede describir el proceso (10–14 días en asentarse, 4–6 meses de duración típica),
    // nunca afirmar la causa del caso de ELLA.
    expect(res.text).toMatch(/consulta|valorac|Dr\.|doctor|revis/i);
  });
});

/**
 * Sigue marcando lo que de verdad falta. Medido el 2026-09-18: ante "¿cuántos días de
 * recuperación para que no se note?" el modelo llama lookupFaq, recibe la ficha #14 —que
 * describe día 1, día 2–3 y día 4 en adelante, pero NUNCA da un total— y marca el hueco.
 * Eso es correcto y hay que protegerlo: los 4 `pending_info` de recuperación del láser en
 * prod (09-12 al 09-17) no eran un bug, eran un dato que de verdad falta en la config.
 */
const RECOVERY_ASK = [
  { role: 'user' as const, content: 'Hola, quiero la promoción de láser CO2' },
  {
    role: 'assistant' as const,
    content:
      '¡Hola! Soy Sofía, del consultorio del Dr. Heriberto Valdivia. El láser CO₂ fraccionado está en $2,999 por sesión (regular $4,500) para citas atendidas a más tardar el miércoles 30 de septiembre. ¿Qué te gustaría mejorar de tu piel?',
  },
  {
    role: 'user' as const,
    content: 'Cuantos dias de recuperación se necesitan despues del láser co2? Osea de que no se note como para ir a trabajar?',
  },
];

describe.skipIf(!evalApiKey)('Heriberto — un hueco de verdad sigue yendo a la cola', () => {
  it('marca el total de días, que el FAQ no tiene, pero suelta las fases que sí tiene', async () => {
    const res = await buildFrontDeskAgent().generate(RECOVERY_ASK, { requestContext: rc() });

    expect(toolIds(res)).toContain('flagPendingInfo');
    // La misma regla del caso de arriba, al revés: lo que el FAQ SÍ trae no se calla.
    // Ficha #14: rojez el primer día, tono marrón el 2.º y 3.º, descamación del 4.º.
    expect(res.text).toMatch(/roj|marr[óo]n|descam|d[íi]a/i);
  });
});
