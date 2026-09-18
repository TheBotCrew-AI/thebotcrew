/**
 * El nudge que tira el cierre — cuando ya hay horarios sobre la mesa.
 *
 * INCIDENTE (Heriberto, 2026-09-02 08:47). El front-desk ofreció dos horas reales salidas
 * de getAvailability ("hoy miércoles, 2 de septiembre, a las 10:30 a.m. o a las 3:45 p.m.,
 * ¿cuál te queda mejor?"). La lead no contestó y 31 minutos después salió el nudge:
 *
 *   «¿Te aparto un espacio para la jornada de primera aplicación de bótox?»
 *
 * Es la MISMA pregunta que el bot acababa de hacer, pero un paso atrás: la decisión ya no
 * era si quería espacio, era cuál de los dos. El nudge reinició la conversación en vez de
 * empujar la elección pendiente, y la lead no volvió a escribir.
 *
 * No es un caso aislado: de las 72 veces (72/72, del 28-08 al 18-09) en que un nudge salió
 * después de que el bot ya había puesto horarios concretos sobre la mesa, NINGUNA los
 * retomó. Es el patrón más repetible del tenant.
 *
 * LA CAUSA ES UNA REGLA NUESTRA, y es una regla buena: el agente de reactivación no ve el
 * calendario, así que tiene prohibido mencionar fechas y horas para que no invente un hueco
 * que el equipo no puede sostener. El efecto colateral es que tampoco puede aludir a los
 * horarios que el front-desk YA ofreció — que sí son reales y están en el historial.
 *
 * La salida no es levantar la prohibición: un slot ofrecido hace 20 horas puede estar
 * ocupado, y repetirlo sería la promesa falsa que la regla existe para evitar. Es aludir a
 * la decisión SIN repetir el día ni la hora, con salida incluida ("¿o te busco otro?").
 *
 * Lo que se defiende:
 *  1. el nudge apunta a los horarios que ya se ofrecieron, no arranca de cero;
 *  2. NO repite ni inventa una hora concreta — la garantía original queda intacta;
 *  3. sigue terminando en pregunta (un nudge sin pregunta es otro bug).
 *
 * Medido en gpt-5.6-luna el 2026-09-18. La regla que defiende este caso es la viñeta
 * "PERO si el ÚLTIMO mensaje del bot..." de `noDatesRule` en reactivation/prompt.ts:
 *
 *                                       sin la regla   con la regla
 *   retoma los horarios ofrecidos            0/3            3/3
 *   no repite ni inventa una hora            3/3            3/3
 *   sin horarios: no alude a ninguno         3/3            3/3
 *
 * El 0/3 del lado rojo coincide con el 72/72 de prod: no es que falle a veces, es que la
 * prohibición lo hacía imposible. Las dos garantías ya estaban verdes antes y siguen verdes
 * — que es lo único que hacía riesgoso tocar esta regla.
 *
 * Live-only (necesita API key); `pnpm eval`, fuera del gate de CI.
 */

import { describe, it, expect } from 'vitest';
import type { TenantContext } from '../../../core/types.js';
import { buildAgentRequestContext } from '../../../core/runtime-context.js';
import type { ChatMessage } from '../../../core/model-messages.js';
import { evalApiKey, evalModel, evalProvider } from '../../front-desk/evals/eval-model.js';
import { parseAngleSelection } from '../angle-select.js';
import { buildReactivationAgent } from '../agent.js';

/** Esta clase de regla es probabilística; una corrida verde ya ha engañado antes. */
const REPEATS = 3;

/** Reactivation solo lee businessName + tone de la config; lo demás es inerte aquí. */
const tenant = (): TenantContext =>
  ({
    tenantId: 't_eval',
    clientId: 'c_eval',
    ghlLocationId: 'loc_eval',
    enabledChannels: ['whatsapp'],
    config: {
      businessName: 'Dr. Heriberto Valdivia',
      timezone: 'America/Chihuahua',
      tone: 'cálido, cercano y seguro',
      services: [],
      hours: {},
      calendars: [],
      faq: [],
      promptOverrides: {},
    },
  } as unknown as TenantContext);

const turn = {
  ghlConversationId: 'conv_eval_pending_slots',
  ghlContactId: 'contact_eval_pending_slots',
  channel: 'whatsapp' as const,
};

/** Los ángulos VIVOS de la a02: la presión bajo la que la regla tiene que aguantar. */
const CANDIDATES = [
  'Retoma con ligereza: pregunta si quiere que le aparten un espacio para su consulta.',
  'Recuérdale que los espacios de esta semana son limitados y pregúntale si le aparta uno.',
  'Como es su primera aplicación, es normal que surjan dudas: pregúntale qué le gustaría aclarar.',
];

/**
 * El historial real hasta el turno del incidente, con los dos horarios ya ofrecidos en el
 * último mensaje del bot. Textual de prod: no lo reescriba nadie "para que se lea mejor".
 */
const HISTORY_WITH_SLOTS: ChatMessage[] = [
  { role: 'user' as const, content: 'PRIMERA VEZ' },
  {
    role: 'assistant' as const,
    content:
      '¡Hola! Soy Sofía, del consultorio del Dr. Heriberto Valdivia. Si nunca te has aplicado bótox, es totalmente normal tener dudas; la consulta incluye valoración y plan personalizado, sin compromiso de aplicártelo ese día si no te sientes segura. ¿Te interesa una zona específica o todo el rostro?',
  },
  { role: 'user' as const, content: 'Mas la frente y ojos' },
  { role: 'assistant' as const, content: '¿Te refieres a las patas de gallo?' },
  { role: 'user' as const, content: 'Si' },
  { role: 'user' as const, content: 'Y entrecejo' },
  {
    role: 'assistant' as const,
    content:
      'Entonces serían frente, patas de gallo y entrecejo, es decir, las tres zonas del full face. Por ser tu primera aplicación queda en $4,200. Se paga en el consultorio, sin anticipo. ¿Te acomoda más venir por la mañana o por la tarde?',
  },
  { role: 'user' as const, content: 'Por la mañana o medio día' },
  {
    role: 'assistant' as const,
    content: 'Tengo hoy miércoles, 2 de septiembre, a las 10:30 a.m. o a las 3:45 p.m., ¿cuál te queda mejor?',
  },
];

/**
 * Alude a algo que YA se le ofreció. Deliberadamente NO hace match con un reinicio
 * genérico ("¿te busco un horario?"), que es exactamente el fallo bajo prueba.
 */
const REFERS_BACK =
  /(que te (pas[ée]|compart[íi]|mand[ée]|di|dej[ée])|alguno de (los|esos|estos)|alguna de (las|esas|estas)|de (los|las) (dos|opciones)|los dos horarios|esos horarios)/i;

/** Cualquier hora concreta: la garantía que NO se puede romper al arreglar esto. */
const CONCRETE_TIME = /\d{1,2}\s*:\s*\d{2}|\d{1,2}\s*(a\.?\s*m|p\.?\s*m)\b/i;

async function nudge(history: ChatMessage[]): Promise<string> {
  const res = await buildReactivationAgent().generate(history, {
    requestContext: buildAgentRequestContext({
      tenant: tenant(),
      turn,
      provider: evalProvider,
      model: evalModel,
      llmApiKey: evalApiKey,
      reactivationCandidates: CANDIDATES,
    }),
    maxSteps: 3,
  });
  // Se parsea igual que en el runner — la etiqueta ANGULO nunca llega al lead.
  return parseAngleSelection(res.text, CANDIDATES.length).message;
}

describe.skipIf(!evalApiKey)('nudge con horarios pendientes — retoma la elección, no reinicia', () => {
  it.each(Array.from({ length: REPEATS }, (_, i) => i + 1))(
    'apunta a los horarios que ya se ofrecieron (corrida %i)',
    async () => {
      const message = await nudge(HISTORY_WITH_SLOTS);

      expect(message).toMatch(REFERS_BACK);
      expect(message).toContain('?');
    },
  );

  it.each(Array.from({ length: REPEATS }, (_, i) => i + 1))(
    'no repite ni inventa una hora concreta (corrida %i)',
    async () => {
      const message = await nudge(HISTORY_WITH_SLOTS);

      expect(message).not.toMatch(CONCRETE_TIME);
    },
  );
});

/**
 * El contrapeso, y es el que protege la regla original. Sin horarios sobre la mesa el nudge
 * NO debe inventarse que los hubo: aludir a "los horarios que te pasé" cuando nunca se pasó
 * ninguno es peor que reiniciar, porque le dice a la lead que ignoró algo que no existió.
 */
const HISTORY_WITHOUT_SLOTS: ChatMessage[] = [
  { role: 'user' as const, content: 'PRECIO' },
  {
    role: 'assistant' as const,
    content:
      '¡Hola! Soy Sofía, del consultorio del Dr. Heriberto Valdivia. El precio del bótox es cerrado por zona y te lo damos por aquí antes de agendar. ¿Qué zona te interesa?',
  },
  { role: 'user' as const, content: 'Frente' },
  {
    role: 'assistant' as const,
    content: 'Para la frente son $2,125, precio regular $2,500. ¿Te gustaría que revisemos un espacio para tu consulta?',
  },
];

describe.skipIf(!evalApiKey)('nudge sin horarios pendientes — la prohibición sigue en pie', () => {
  it.each(Array.from({ length: REPEATS }, (_, i) => i + 1))(
    'no alude a horarios que nunca se ofrecieron ni propone uno (corrida %i)',
    async () => {
      const message = await nudge(HISTORY_WITHOUT_SLOTS);

      expect(message).not.toMatch(REFERS_BACK);
      expect(message).not.toMatch(CONCRETE_TIME);
      expect(message).toContain('?');
    },
  );
});
