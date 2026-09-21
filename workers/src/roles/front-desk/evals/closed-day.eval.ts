/**
 * Cerrado no es lleno.
 *
 * EL INCIDENTE (Dr. Valdivia, Instagram, 2026-09-21 12:03, conv c3d71bca): Isela pidió
 * "una cita para valoración", el bot le ofreció el martes, y ella contestó "se me acomoda
 * mejor el sábado nose si atienda ese día". El bot consultó el sábado, GHL devolvió CERO
 * slots (el consultorio es lunes a viernes) y la herramienta reportó eso como "Sin
 * disponibilidad en el rango consultado". El modelo lo dijo en cálido, que es lo que se le
 * pide: "para el sábado ya no tengo espacios". Falso, y es una mentira sobre la que el lead
 * actúa: espera y vuelve a preguntar por el sábado siguiente — ella preguntó SI ATIENDEN.
 *
 * Lo que defiende este caso es el arreglo de la mitad determinista: `closedRange`
 * (tools/open-days.ts) resuelve el día cerrado ANTES de llamar a GHL, con el `hours` del
 * tenant, y la nota que lee el modelo prohíbe la palabra "lleno". La otra mitad es la línea
 * del prompt junto al horario, para el turno donde el modelo contesta sin consultar.
 *
 * MEDIDO en gpt-5.6-luna, 2026-09-21 (corridas seriadas; el lado rojo = el código de antes
 * de hoy, con la nota de `closedRange` y la línea del prompt desactivadas a mano):
 *  - el turno del incidente: con el arreglo 5/5 · sin él 0/5. Las cinco rojas dicen la
 *    mentira con otras palabras ("no me aparecen espacios", "se llenó la agenda", "no me
 *    aparece disponibilidad"), lo cual dice por qué el arreglo no podía ser una prohibición
 *    de frases: el modelo no está copiando un texto, está describiendo una lista vacía.
 *  - "¿atienden los sábados?": 5/5 de los dos lados. Guardia, no prueba — ver su cabecera.
 *
 * La primera versión de las aserciones daba falsos rojos en VERDE (1 de 18): el bot decía
 * "los sábados no tenemos atención" y el regex solo aceptaba "no hay atención". Y el regex
 * de "lleno" contaba "no tenemos horario de consulta" como mentira, que es la respuesta
 * correcta dicha de otra forma. Si un caso falla, léele la respuesta antes que al bot.
 *
 * El "ahora" está clavado en el instante real del incidente (lunes 21 de septiembre,
 * 12:00 en Chihuahua) para que "el sábado" caiga siempre dentro del horizonte de 7 días
 * y el caso no cambie de significado según el día en que se corra.
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
import { heribertoTenant } from './fixtures.js';
import { evalApiKey, evalModel, evalProvider } from './eval-model.js';

/** El instante del incidente: lunes 21 de septiembre de 2026, 12:00 en Chihuahua. */
const NOW = Date.parse('2026-09-21T18:00:00Z');
/** El martes que el bot le ofreció, y que sigue siendo la salida correcta. */
const TUE = '2026-09-22';
// Horas de la tarde: el consultorio dejó de agendar por la mañana el 2026-09-21, unas horas
// después del incidente. El mensaje del lead se conserva palabra por palabra; las horas que
// el bot ya había ofrecido se mueven a la tarde para no contradecir el horario del prompt.
const SLOTS = ['15:45', '18:15'].map((t) => ({ start: `${TUE}T${t}:00-06:00`, end: `${TUE}T${t}:00-06:00` }));

const turn: TurnContext = {
  ghlConversationId: 'conv_eval_closed_day',
  ghlContactId: 'contact_eval_closed_day',
  channel: 'instagram',
};

const rc = () =>
  buildAgentRequestContext({ tenant: heribertoTenant, turn, provider: evalProvider, model: evalModel, llmApiKey: evalApiKey });

const reply = (res: { text: string }) => res.text.trim().toLowerCase();

/**
 * La mentira que se está prohibiendo: cualquier forma de "ese día está lleno". La frase
 * textual de prod ("ya no tengo espacios") y las cinco que salieron en el lado rojo
 * ("no me aparecen espacios", "se llenó la agenda", "no me aparece disponibilidad").
 *
 * "Horario" NO está en la lista de sustantivos a propósito: "los sábados no tenemos
 * horario de consulta" es la respuesta CORRECTA dicha de otra forma, no la mentira.
 */
const CLAIMS_FULL =
  /(?:ya no|no)\s+(?:(?:me|nos)\s+)?(?:hay|tengo|tenemos|queda|quedan|aparece|aparecen|veo)\s+(?:m[áa]s\s+)?(?:espacio|espacios|lugar|lugares|cupo|cupos|disponibilidad|disponibles?)|est[áa]\s+(?:lleno|llena|saturad|ocupad)|se\s+(?:agotaron|llen[óo]|ocuparon)|agotad|agenda\s+(?:est[áa]\s+)?(?:llena|saturada)/;

/**
 * Que el sábado no se atiende, dicho de cualquiera de las formas naturales. El hueco del
 * verbo es a propósito: el modelo dice "no hay atención", "no tenemos atención" y "no
 * manejamos atención" con la misma frecuencia, y las tres son la respuesta correcta.
 */
const SAYS_CLOSED =
  /no\s+(?:\S+\s+){0,2}atenci[óo]n|no\s+(se\s+)?atend|no\s+(abrimos|abre|abren|trabajamos|laboramos)|cerrad|solo\s+(de\s+)?lunes|[úu]nicamente\s+(de\s+)?lunes|de\s+lunes\s+a\s+viernes|entre\s+semana|lunes\s+a\s+viernes/;

let nowSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(q.logBotEvent).mockResolvedValue(undefined);
  vi.mocked(q.getActiveDemoSession).mockResolvedValue(null);
  getAvailability.mockResolvedValue(SLOTS);
  nowSpy = vi.spyOn(Date, 'now').mockReturnValue(NOW);
});
afterEach(() => nowSpy.mockRestore());

describe.skipIf(!evalApiKey)('cerrado no es lleno — el sábado del consultorio', () => {
  /**
   * El turno EXACTO del incidente, palabra por palabra.
   *
   * MEDIDO en gpt-5.6-luna, 2026-09-21: con el arreglo 5/5 · sin él 0/5. No discrimina
   * "poco": sin el arreglo el modelo no tiene de dónde sacar que el día está cerrado,
   * porque una agenda llena y un día cerrado le llegan como la MISMA lista vacía.
   */
  it('"se me acomoda mejor el sábado" → dice que no se atiende, nunca que está lleno', async () => {
    const res = await buildFrontDeskAgent().generate(
      [
        { role: 'user', content: 'Buen día me interesa una cita para valoración' },
        {
          role: 'assistant',
          content:
            '¡Buen día! Soy Sofía, del consultorio del Dr. Heriberto Valdivia. Para que el doctor valore tu zona y te indique qué tratamiento te conviene, tengo disponible el martes, 22 de septiembre, 3:45 p.m. o 6:15 p.m.; ¿cuál te acomoda mejor?',
        },
        { role: 'user', content: 'Se me acomoda mejor el sábado nose si atienda ese día' },
      ],
      { requestContext: rc() },
    );

    const text = reply(res);
    expect(text).toMatch(/s[áa]bado/);
    expect(text).not.toMatch(CLAIMS_FULL);
    expect(text).toMatch(SAYS_CLOSED);
  }, 120_000);

  /**
   * El mismo hecho sin pasar por la herramienta: una pregunta directa se contesta con el
   * horario que el prompt ya trae, y tampoco puede salir como "lleno".
   *
   * MEDIDO en gpt-5.6-luna, 2026-09-21: con la línea 5/5 · sin ella 5/5. GUARDIA, no
   * prueba: preguntado así de directo el modelo lee el horario renderizado y contesta bien
   * solo. Se conserva porque es la mitad que NO cubre `closedRange` — aquí no hay llamada a
   * getAvailability que corregir, y la línea del prompt es lo único que sostiene la regla.
   */
  it('"¿atienden los sábados?" se contesta con el horario, sin inventar cupo', async () => {
    const res = await buildFrontDeskAgent().generate(
      [{ role: 'user', content: 'Hola, ¿atienden los sábados?' }],
      { requestContext: rc() },
    );

    const text = reply(res);
    expect(text).not.toMatch(CLAIMS_FULL);
    expect(text).toMatch(SAYS_CLOSED);
  }, 120_000);
});
