/**
 * Dr. Heriberto Valdivia — golden cases for the tenant's persona (seeded 2026-08-28).
 *
 * A med-spa tenant that BOOKS through the bot (unlike MADI) and carries a medical
 * line the others don't: bariatría with GLP-1. Three rules are defended, each a
 * different failure with a real cost:
 *  1. Medical limit — a GLP-1 question is answered with "eso lo valora el doctor en
 *     consulta", never with a drug name or a dose, and it is NOT a pending_info (the
 *     team is not going to answer "¿qué dosis me pondría?" over WhatsApp either).
 *  2. The FAQ bank wins over "lo que no sabes" — facts Leo wants stated ONLY when asked
 *     (the free valoración, facturación, the enzimas and láser CO₂ fichas) live in `faq`,
 *     not in the prompt. The consulta-cost case proves the FACT flows: with the entry the
 *     bot says "sin costo" and does not flag pending_info; without it (RULE_OFF drops the
 *     entry) the same question must go to the review queue. The CO₂ ficha is four entries
 *     on purpose, and the drip case proves a "¿cómo es?" gets ONE piece, not the wall.
 *  3. What gets booked is the CONSULTA — `calendars` has no "Botox" key, so a
 *     serviceName of "Botox" returns "No hay un calendario configurado" and the bot
 *     cannot book at all.
 *
 * The offline case pins what the prompt renders for this config: two ranges per day
 * (the first tenant with a split schedule) and the custom flow replacing the built-in.
 *
 * Each live case is measured with its defending rule stripped (`HERIBERTO_RULE_OFF=1`,
 * which removes the rule from a copy of the fixture — prod text is never touched):
 *
 *   MEDIDO en gpt-5.6-luna, 2026-08-28 (corridas seriadas):
 *   - límite médico:      con regla 5/5 · sin regla (houseRules + "Dudas que llegan seguido" fuera) 1/5.
 *     Primera versión de la regla ("NUNCA menciones nombres de medicamentos"): 3/5 — las 2 fallas
 *     eran la misma frase, "la semaglutida puede formar parte del tratamiento…": el modelo REPETÍA
 *     el nombre que el lead escribió y le ponía una valoración suave encima, leyendo la regla como
 *     "no saques uno nuevo". El texto de prod ahora dice explícitamente que tampoco se repite el
 *     que el lead nombró ni se opina si "puede ser opción"; con eso, 5/5 el mismo día.
 *   - costo de consulta:  con la entrada de FAQ 3/3 dice "sin costo" vía lookupFaq y no marca
 *     pending_info · sin la entrada 3/3 hace lo contrario (lo confirma con el equipo +
 *     flagPendingInfo). La aserción se invierte con RULE_OFF: lo que se prueba es que el DATO
 *     manda, en las dos direcciones. (Antes de cargar la FAQ, 2026-08-28 por la tarde, el caso
 *     era "nunca digas sin costo"; Leo cargó el dato esa noche.)
 *   - goteo láser CO₂:    con regla 3/3 · sin regla ("Ritmo y estilo" + la excepción de lookupFaq
 *     fuera) 2/3 — discrimina poco porque partir la ficha en cuatro entradas ya hace la mayor
 *     parte del trabajo (lookupFaq devuelve primero la de "qué es"); la falla sin regla fue un
 *     mensaje largo que ya traía recuperación y cuidados. Se conserva como guardia de la partición.
 *   MEDIDO 2026-08-29 (regla "Siguiente paso" + gancho de la consulta):
 *   - "¿facturan?" sin cita:  con regla 5/5 · con la REGLA DE ORO vieja 3/5 — y la falla es la frase
 *     exacta de prod ("¡hola! sí, se factura sin problema."). Con historia corta no reproducía (5/5
 *     ambos lados); hizo falta la historia real (agendó → canceló → "¿facturan?").
 *     Re-medido 2026-09-03 tras los cambios de prompt de ese día: 9/10 con la fixture nueva y
 *     4/4 con la previa. La única falla es un lookupFaq que no se llama ("déjame confirmarlo
 *     con el equipo"), no el gancho que el caso defiende: ruido, no regresión.
 *   - estacionamiento con cita: 5/5 ambos lados — la sección de modo asistencia del prompt base ya
 *     lo cubre; queda como guardia de "sin pregunta cuando no se necesita".
 *   - gancho "sin costo":  con regla 5/5 · sin regla 3/5. Primera versión (una línea en
 *     qualificationNotes, "SOLO si lo preguntan") 3/5 vs 4/5 = nada: lookupFaq no encuentra
 *     coincidencia para "me interesa el ácido hialurónico" y devuelve la FAQ COMPLETA, así que la
 *     entrada de la consulta sin costo está frente al modelo en casi cualquier pregunta por un
 *     tratamiento. Lo que sí sirvió: prohibición en houseRules (manda sobre el flujo) + la propia
 *     entrada de FAQ auto-condicionada ("Solo si el lead pregunta por el costo de la consulta: …"),
 *     que sigue contestando 5/5 cuando SÍ preguntan.
 *   - agenda "Consulta":  con regla 3/3 · sin regla (toolInstructions.getAvailability fuera) 0/3
 *     — sin la instrucción inventa serviceName="Consulta de Medicina Estética", que no es
 *     llave de `calendars`, y la herramienta contesta "No hay un calendario configurado".
 *   MEDIDO 2026-09-01 (regla "Zona o tratamiento fuera de tu lista"):
 *   - "paoada" bajo la variante a05: con regla 9/10 (re-medido 2026-09-04) · sin regla 5/10 fallas (contesta patas
 *     de gallo con precio de bótox — el incidente). El mensaje LITERAL del incidente
 *     ("Necesito saber como es el tratamiento de la paoada y los costos") NO reprodujo:
 *     15/15 verdes sin la regla (prompt base, hilo real y variante a05 por igual) — la
 *     falla de prod fue cola de probabilidad con esa frase. Lo que sí discrimina es la
 *     respuesta seca "La paoada" al menú de zonas del opener de campaña: el modelo la
 *     encaja en la opción más parecida en la mitad de las corridas.
 *   MEDIDO 2026-09-03 (la promoción se dice completa):
 *   - precio de frente: con regla 3/3 · sin regla 0/3. RULE_OFF restaura el texto de prod de
 *     antes de hoy (la línea de bótox con los números de promoción a secas, sin el regular ni
 *     la fecha, y sin el párrafo que ordena los tres datos): las 3 corridas dan $2,125 y ya —
 *     el lead lee el precio de siempre y la promoción no existe para él. No discrimina "poco":
 *     sin el dato en la lista el modelo no tiene de dónde sacar el $2,500.
 *   - maseteros: 3/3 sin RULE_OFF (no tiene lado rojo — es la guardia de que la promoción
 *     no se derrame a la única zona sin descuento, inventándole un "regular").
 *   MEDIDO 2026-09-04 (zonas por su nombre de calle):
 *   - antifaz: con el vocabulario 3/3 · sin él 0/3 — pregunta "¿te refieres a patas de
 *     gallo?" las tres veces, que es lo que le pasó a tres leads reales (uno contestó
 *     "me sorprende que no sepa el término" y se fue).
 *   - ventrílocuo: 3/3 · sin él 1/3. Discrimina menos a propósito: houseRules ya rutea
 *     "volumen o contorno → ácido hialurónico", así que a veces llega solo. Se queda como
 *     guardia de que no le peguen un precio de bótox a esa zona.
 *   - El FAQ solo NO alcanza: houseRules manda confirmar cualquier zona que no aparezca
 *     "tal cual" en la lista de tratamientos, y esa regla le gana al banco de FAQ. Con las
 *     fichas cargadas pero sin el término en la lista, "antifaz" seguía fallando 4/4.
 *   MEDIDO 2026-09-04 (lada 619):
 *   - con la ficha 3/3 · sin ella 0/3, y el lado rojo reproduce el mensaje de prod casi
 *     palabra por palabra ("la lada 619 corresponde a san diego, california, estados
 *     unidos" + siguiente paso, sin decir dónde está el consultorio). Es el mejor lado
 *     rojo posible: no es una simulación del fallo, es el fallo.
 *   MEDIDO 2026-09-04 (ciudad / dirección / estacionamiento):
 *   - los dos casos: con la separación 3/3 · sin ella 0/3. El lado rojo devuelve la plaza,
 *     el código postal y el estacionamiento a una pregunta de ciudad — que es la queja que
 *     lo originó (un lead preguntó la ciudad varias veces y recibió la ficha completa).
 *   - Hay que revertir LAS DOS mitades (la línea del offering y la ficha de FAQ): con una
 *     sola el modelo saca la dirección de la otra y el caso no discrimina.
 *   MEDIDO 2026-09-03 (conocer al paciente antes de la logística):
 *   - con regla 16/18 · sin regla (el texto de ayer: la hora catalogada como una de las "dos
 *     cosas", y "ni van en orden fijo") 1/4. Origen: una cuenta sobre prod — de 255 mensajes
 *     del bot, 30 preguntan "¿mañana o tarde?" y 7 caen en sus DOS primeros mensajes.
 *   - La PRIMERA versión de la regla medía 6/10 en VERDE, y las 4 fallas eran idénticas:
 *     contestaba la dirección y no preguntaba NADA. Estaba escrita como prohibición ("no la
 *     haces hasta que…", "no la hora") y el modelo obedeció dejando de preguntar — la misma
 *     falla que documentan CLOSED_QUESTION_RULE y WARM_NO_RULE. Reescrita diciendo qué SÍ
 *     preguntar ("ESA es tu pregunta por defecto… cierra ese MISMO mensaje preguntándole"),
 *     6/6. El lado rojo falla igual por no preguntar nada, no por preguntar la hora.
 *   - El probe usa dos mensajes (headline + "dónde se ubican"). Con el hilo real de tres
 *     ("¿y trabajan los sábados?" encima) baja a 2/4, pero por la regla de GOTEO: el bot
 *     contesta una duda y se para. Ese caso mide el goteo, no esta regla.
 *   MEDIDO 2026-09-03 (campañas de Sculptra y láser CO₂):
 *   - láser: con regla 3/3 · sin regla 5/6. La corrida roja que pasa es informativa: RULE_OFF
 *     revierte la LISTA de tratamientos, no el banco de FAQ, y la ficha del láser también trae
 *     el precio de promoción — así que lookupFaq puede filtrarlo. Se deja así a propósito: un
 *     rojo total exigiría desarmar la FAQ, que no es el estado que se está defendiendo.
 *   - Sculptra: con regla 3/3 · sin regla 0/3.
 *   - El lado rojo de este bloque estuvo ROTO unos minutos: la regla de precio pasó de "Con el
 *     bótox…" a "Con el bótox, el láser CO₂ y Sculptra…" y la constante del eval siguió
 *     apuntando al texto viejo, así que RULE_OFF lanzaba en vez de generar (fallo en 3 ms,
 *     no en 6 s). Si un lado rojo falla instantáneo, sospecha del ancla antes que del modelo.
 *   - El caso de candidatura de Sculptra ("¿tú crees que yo sí soy candidata?") se escribió y
 *     se TIRÓ: pasa igual con y sin el bullet de la variante, porque houseRules ya prohíbe
 *     calificar a nadie y sobrevive a la variante por diseño. El bullet se queda en prod como
 *     refuerzo; un caso que pasa de los dos lados no prueba nada.
 *   MEDIDO 2026-09-03 (las tres del repaso de prompt):
 *   - la consulta con su razón: con regla 3/3 · sin regla 0/3. El origen es una cuenta sobre
 *     prod, no una corazonada: en 4 días 69 mensajes del bot mencionaron la consulta y solo
 *     2 dijeron para qué le sirve al lead. La primera versión del caso medía 2/3 en VERDE, y
 *     las dos fallas eran de la aserción, no del bot — "para que el Dr. valore la zona" (el
 *     regex pedía indicativo) y un turno donde dio precio en vez de horarios. El caso ahora
 *     pide horarios explícitamente y acepta el subjuntivo.
 *   - primera vez con miedo: con regla 3/3 · sin regla 0/3. Normalizar el miedo ya estaba;
 *     lo que faltaba era el dato que lo desarma (no se aplica nada sin que ella lo autorice).
 *   - anticipo: con el dato en la BASE 3/3 · sin él 0/3 — las 3 corridas rojas contestan
 *     "déjame confirmarlo con el equipo" por un dato que sí tenemos, porque hasta hoy vivía
 *     solo en las variantes. La otra mitad del cambio (redacción en positivo) NO quedó bajo
 *     prueba: ver la nota del propio caso.
 *   MEDIDO 2026-09-18 (llegar sin cita — el hilo de Irma, a02):
 *   - "yo después voy para que me digan ahí gracias": con regla 10/10 dicen "cita previa" (dos
 *     ofrecían "¿te aparto un espacio?" en vez de "agendar"; la aserción acepta ambas) · sin la
 *     sección 0/5 — el lado rojo es el mensaje de prod ("claro, aquí te esperamos cuando
 *     gustes"): el "gracias" la mete en el caso "se despidió → sin pregunta" del flujo.
 *   - "por ahorita no" tras el aviso: 5/5 con y sin regla. Guardia, no prueba: el flujo ya
 *     se despide solo ante un no con gracias.
 *   MEDIDO 2026-09-21 (el consultorio agenda solo por la tarde):
 *   - "por la tarde no puedo ningún día": con la regla 5/5 · sin ella 0/5, y las cinco rojas
 *     son la misma pérdida — el bot se DESPIDE ("cuando tengas una tarde libre, escríbeme").
 *     Sin una salida que ofrecer, cierra; con ella, promete preguntarle al doctor y deja la
 *     solicitud marcada. El caso del cierre (flagAwaitingHuman sin preguntas) mide 4/5 en
 *     rojo porque su propia historia ya trae el plan: es guardia, no prueba.
 *   - El horario dejó de tener franja de mañana el 2026-09-21, así que los slots mockeados de
 *     este archivo son todos de la tarde. Un slot de mañana contradice el `hours` del tenant
 *     y, desde `closedRange`, el prompt lo dice en voz alta.
 *
 * Live cases need an API key (`pnpm eval`); excluded from the CI gate.
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
import { buildFrontDeskInstructions } from '../prompt.js';
import { parseFrontDeskConfig } from '../config.js';
import { slotLabel } from '../tools/slot-label.js';
import { buildAgentRequestContext } from '../../../core/runtime-context.js';
import type { TenantContext, TurnContext } from '../../../core/types.js';
import { HERIBERTO_FAQ, HERIBERTO_PERSONA, heribertoTenant } from './fixtures.js';
import { INCIDENT_A05_OFFERING, INCIDENT_A05_QUALIFICATION_NOTES } from './heriberto-a05-incident.js';
import { INCIDENT_A02_OFFERING, INCIDENT_A02_QUALIFICATION_NOTES } from './heriberto-a02-incident.js';
import { evalApiKey, evalModel, evalProvider } from './eval-model.js';

const TZ = 'America/Chihuahua';
const RULE_OFF = process.env.HERIBERTO_RULE_OFF === '1';

/** Drop one section (`# Title` … up to the next `# `) from a markdown-ish prompt field. */
const withoutSection = (text: string, title: string): string => {
  const start = text.indexOf(title);
  if (start < 0) throw new Error(`section not found: ${title}`);
  const next = text.indexOf('\n# ', start + 1);
  return (text.slice(0, start) + (next < 0 ? '' : text.slice(next + 1))).trim();
};

/** The rule the "next step" section replaced (2026-08-29) — the red side of that case. */
const OLD_GOLDEN_RULE =
  '- REGLA DE ORO: cada mensaje tuyo termina en UNA pregunta o un siguiente paso concreto. ÚNICA excepción: una vez agendada la cita, cierras y no preguntas más.';

/**
 * The fixture with ONE defending rule removed, per case. Only used to prove the case
 * discriminates — the numbers in the header come from running with RULE_OFF=1.
 */
/**
 * El ancla del caso de contraste: [0] es el texto VIVO en prod (el que RULE_OFF quita) y
 * [1] la instrucción floja de antes del 2026-09-01. Desde el 2026-09-21 el consultorio
 * agenda solo por la tarde, así que el contraste ya no es mañana/tarde sino temprano/tarde
 * DENTRO de la tarde — misma regla, mismo motivo (dos horas pegadas no son dos opciones).
 */
const OLD_GETAVAILABILITY_WORDING = [
  'El consultorio agenda ÚNICAMENTE por la tarde: ofrece exactamente DOS horarios de la tarde SEPARADOS entre sí, del día más próximo que tenga dos; si ese día solo tiene uno, el segundo sácalo del día siguiente. Dos horarios pegados (como 3:45 y 4:15) no son una opción real: deja al menos hora y media entre uno y otro. Van en un solo mensaje corto y sin lista con viñetas',
  'Ofrece exactamente DOS horarios, en un solo mensaje corto y sin lista con viñetas',
] as const;

/**
 * The pre-2026-09-03 bótox pricing — the red side of the promo case. Back then the promo
 * numbers WERE the price: no regular to compare against, no deadline, and the campaign
 * variants were told not to call it a promotion at all.
 */
const PROMO_BOTOX_LINE =
  '- Botox — precio de promoción de septiembre, por zona: frente $2,125 (regular $2,500), entrecejo $1,700 (regular $2,000), patas de gallo $1,700 (regular $2,000), maseteros $3,500 (su precio de siempre); full face (frente, entrecejo y patas de gallo) $4,200 (regular $6,000). La promoción aplica a las citas que se atienden a más tardar el miércoles 30 de septiembre.';
const PLAIN_BOTOX_LINE =
  '- Botox — por zona: frente $2,125, entrecejo $1,700, patas de gallo $1,700, maseteros $3,500; full face (frente, entrecejo y patas de gallo) $4,200.';
const PROMO_LASER_LINE =
  '- Láser CO₂ Fraccionado — precio de promoción de septiembre: $2,999 por sesión (regular $4,500).';
const PLAIN_LASER_LINE = '- Láser CO₂ Fraccionado — $3,000 por sesión.';
const PROMO_SCULPTRA_LINE =
  '- Sculptra — precio de promoción de septiembre: $12,499 por vial o sesión (regular $18,000); el tratamiento completo de 3 viales son $30,000.';
const PLAIN_SCULPTRA_LINE = '- Sculptra — $12,500 por vial o sesión (tratamiento completo de 3 viales: $30,000).';
const PROMO_PRICE_RULE_START =
  'Con el bótox, el láser CO₂ y Sculptra hay promoción de septiembre, y los tres datos van SIEMPRE juntos';

/** El bullet que explica PARA QUÉ sirve la consulta (prod, 2026-09-03). */
const CONSULTA_WHY_RULE =
  '- La consulta no se anuncia como trámite ("primero pasas a valoración"): así se lee como un peaje que hay que pagar para llegar al tratamiento. En el MISMO mensaje en que ofreces los horarios, dile en media línea para qué le sirve a ELLA — que el Dr. Valdivia le valora la zona en persona, que ahí se confirma qué tratamiento le corresponde, o que le da el precio exacto antes de aplicar nada. UNA razón, la que encaje con lo que te contó, nunca las tres.';
/** La frase que tranquiliza a quien va por primera vez (prod, 2026-09-03). */
const NO_PROCEDURE_WITHOUT_CONSENT =
  ' Y dilo explícito, que es lo que de verdad tranquiliza: no se le aplica ningún procedimiento sin que ella lo autorice.';
/**
 * El lado rojo de los pagos NO es una regla removida: es config escrita en negativo,
 * pegada al bloque de pagos de la base. Es el texto literal que las 6 variantes tenían
 * hasta hoy, y que produjo 3 mensajes de prod abriendo con "No se pide anticipo…"
 * (2026-09-01 → 09-02) pese a WARM_NO_RULE.
 */
const POSITIVE_PAYMENTS_LINE =
  'El pago es en el consultorio el día de la cita: efectivo, tarjeta o transferencia, y con tarjeta siempre hay 3 meses sin intereses. Si pregunta por anticipos, paquetes o membresías, contéstalo desde lo que sí hay — aquí se paga completo ese día y ya.';
/** El bloque de pagos de la base tal como estaba hasta hoy: SIN el dato del anticipo,
 *  que vivía solo en las 6 variantes. Un lead sin keyword se quedaba sin respuesta. */
const PAYMENTS_WITHOUT_THE_FACT = 'Efectivo, tarjeta y transferencia. Con tarjeta siempre hay 3 meses sin intereses.';

/** La regla que ordena descubrimiento antes de logística (prod, 2026-09-03). */
const DISCOVERY_FIRST_RULE = `Antes de ofrecer la consulta quieres entender UNA cosa: qué le gustaría mejorar, o qué tratamiento trae en mente. Sale cuando encaje en lo que se está platicando, nunca como formulario.
Mientras no lo sepas, ESA es tu pregunta por defecto: cada vez que le contestes una duda suya (dirección, horario, formas de pago, estacionamiento), cierra ese MISMO mensaje preguntándole qué le gustaría mejorar. Nunca dejes el dato solo. "¿Qué día te acomoda?" es el primer paso de agendar, no de conocerla: esa pregunta llega después, cuando ya sabes qué le interesa.`;
/** Lo que decía hasta hoy: la hora catalogada como pregunta de descubrimiento, y permiso
 *  explícito para hacerla primero ("ni van en orden fijo"). */
const BOTH_THINGS_ANY_ORDER = `Antes de ofrecer la consulta quieres entender dos cosas. NO son un formulario ni van en orden fijo: salen de UNA en UNA, cuando encajen en lo que se está platicando.
- Qué le gustaría mejorar, o qué tratamiento trae en mente.
- Qué le acomoda más para venir: por la mañana o por la tarde.`;

/** Ciudad, dirección y estacionamiento como tres datos distintos (prod, 2026-09-04). */
const CITY_SPLIT_LINES = `- Ciudad: Chihuahua, Chih. Cuando pregunten en qué ciudad están, esa es la respuesta COMPLETA: una línea y ya. La dirección exacta va solo cuando la piden.
- Dirección (cuando la pidan): Periférico de la Juventud 6902, Plaza Cumbres, Chihuahua, Chih., C.P. 31217.
- Estacionamiento: la plaza tiene. Es un dato aparte — se menciona solo si preguntan por él, nunca pegado a la dirección.`;
/** Lo que había hasta hoy: los tres datos en una sola línea, y la ficha de dirección
 *  arrastrando el estacionamiento. Por eso una pregunta de ciudad devolvía la plaza entera. */
const BUNDLED_ADDRESS_LINE =
  '- Dirección: Periférico de la Juventud 6902, Plaza Cumbres, Chihuahua, Chih., C.P. 31217. La plaza tiene estacionamiento.';
const ADDRESS_FAQ_SPLIT = 'En Periférico de la Juventud 6902, Plaza Cumbres, Chihuahua, Chih., C.P. 31217.';
const ADDRESS_FAQ_BUNDLED =
  'En Periférico de la Juventud 6902, Plaza Cumbres, Chihuahua, Chih., C.P. 31217. La plaza tiene estacionamiento.';

/** El vocabulario de zonas que los leads usan y la lista no tenía (prod, 2026-09-04). */
const ZONE_VOCABULARY = `"Zona del antifaz" es como mucha gente llama al full face: son esas mismas tres zonas (frente, entrecejo y patas de gallo), con ese mismo precio. Si te la piden por ese nombre, ya sabes cuál es — no preguntes a qué se refieren.
Las "líneas de ventrílocuo" (o líneas de marioneta) son los surcos que bajan de las comisuras de los labios hacia la barbilla. No son zona de bótox: ahí lo que se valora es ácido hialurónico.

`;

const tenantWithout = (
  rule: 'afternoon-only' | 'medical' | 'faq-consulta' | 'drip' | 'service-name' | 'next-step' | 'consulta-hook' | 'zone-list' | 'slot-contrast' | 'promo-price' | 'consulta-why' | 'first-time-fear' | 'negative-payments' | 'discovery-first' | 'city-split' | 'lada-faq' | 'zone-vocabulary' | 'walk-in',
): TenantContext => {
  const p = HERIBERTO_PERSONA;
  const cfg = heribertoTenant.config;
  if (rule === 'walk-in') {
    return {
      ...heribertoTenant,
      config: { ...cfg, promptOverrides: { ...p, houseRules: withoutSection(p.houseRules, '# Si piensa llegar sin cita') } },
    };
  }
  if (rule === 'afternoon-only') {
    return {
      ...heribertoTenant,
      config: { ...cfg, promptOverrides: { ...p, houseRules: withoutSection(p.houseRules, '# Solo se agenda por la tarde') } },
    };
  }
  if (rule === 'slot-contrast') {
    const current = p.toolInstructions.getAvailability;
    if (!current.includes(OLD_GETAVAILABILITY_WORDING[0])) throw new Error('contrast wording not found');
    return {
      ...heribertoTenant,
      config: {
        ...cfg,
        promptOverrides: {
          ...p,
          toolInstructions: {
            ...p.toolInstructions,
            getAvailability: current.replace(OLD_GETAVAILABILITY_WORDING[0], OLD_GETAVAILABILITY_WORDING[1]),
          },
        },
      },
    };
  }
  if (rule === 'zone-vocabulary') {
    // Las dos mitades: el vocabulario en la lista de tratamientos Y las fichas de FAQ. La
    // que decide es la lista — houseRules manda confirmar cualquier zona que "no aparece
    // tal cual" ahí, y esa regla le gana al FAQ.
    const offering = p.offering.replace(ZONE_VOCABULARY, '');
    if (offering === p.offering) throw new Error('zone vocabulary not found');
    const faq = HERIBERTO_FAQ.filter((f) => !/antifaz|ventr[íi]locuo/i.test(f.q));
    if (faq.length === HERIBERTO_FAQ.length) throw new Error('zone FAQ entries not found');
    return { ...heribertoTenant, config: { ...cfg, faq, promptOverrides: { ...p, offering } } };
  }
  if (rule === 'lada-faq') {
    // El DATO, no una regla: sin la ficha el bot contesta de conocimiento general (San
    // Diego) y deja al lead con la duda de dónde está el consultorio — que es lo que pasó
    // en prod el 2026-09-04 antes de cargarla.
    const faq = HERIBERTO_FAQ.filter((f) => !/lada 619/i.test(f.q));
    if (faq.length === HERIBERTO_FAQ.length) throw new Error('lada FAQ entry not found');
    return { ...heribertoTenant, config: { ...cfg, faq } };
  }
  if (rule === 'city-split') {
    // Se revierten LAS DOS mitades: la línea del offering y la ficha de FAQ. Con solo una
    // el caso no probaría nada — el modelo saca la dirección de cualquiera de las dos.
    const offering = p.offering.replace(CITY_SPLIT_LINES, BUNDLED_ADDRESS_LINE);
    if (offering === p.offering) throw new Error('city split lines not found');
    const faq = HERIBERTO_FAQ.filter((f) => !/En qué ciudad están/i.test(f.q)).map((f) =>
      f.a === ADDRESS_FAQ_SPLIT ? { ...f, a: ADDRESS_FAQ_BUNDLED } : f,
    );
    if (faq.length === HERIBERTO_FAQ.length) throw new Error('city FAQ entry not found');
    return { ...heribertoTenant, config: { ...cfg, faq, promptOverrides: { ...p, offering } } };
  }
  if (rule === 'discovery-first') {
    const qualificationNotes = p.qualificationNotes.replace(DISCOVERY_FIRST_RULE, BOTH_THINGS_ANY_ORDER);
    if (qualificationNotes === p.qualificationNotes) throw new Error('discovery-first rule not found');
    return { ...heribertoTenant, config: { ...cfg, promptOverrides: { ...p, qualificationNotes } } };
  }
  if (rule === 'consulta-why') {
    const qualificationNotes = p.qualificationNotes.replace(`\n${CONSULTA_WHY_RULE}`, '');
    if (qualificationNotes === p.qualificationNotes) throw new Error('consulta-why rule not found');
    return { ...heribertoTenant, config: { ...cfg, promptOverrides: { ...p, qualificationNotes } } };
  }
  if (rule === 'first-time-fear') {
    const qualificationNotes = p.qualificationNotes.replace(NO_PROCEDURE_WITHOUT_CONSENT, '');
    if (qualificationNotes === p.qualificationNotes) throw new Error('consent sentence not found');
    return { ...heribertoTenant, config: { ...cfg, promptOverrides: { ...p, qualificationNotes } } };
  }
  if (rule === 'negative-payments') {
    const offering = p.offering.replace(POSITIVE_PAYMENTS_LINE, PAYMENTS_WITHOUT_THE_FACT);
    if (offering === p.offering) throw new Error('pagos anchor not found');
    return { ...heribertoTenant, config: { ...cfg, promptOverrides: { ...p, offering } } };
  }
  if (rule === 'promo-price') {
    // Both halves go: the comparison in the price list AND the rule that orders the three
    // data points. What's left is exactly what prod said before 2026-09-03.
    const offering = p.offering
      .replace(PROMO_BOTOX_LINE, PLAIN_BOTOX_LINE)
      .replace(PROMO_LASER_LINE, PLAIN_LASER_LINE)
      .replace(PROMO_SCULPTRA_LINE, PLAIN_SCULPTRA_LINE);
    if (offering === p.offering) throw new Error('promo botox line not found');
    for (const promo of [PROMO_BOTOX_LINE, PROMO_LASER_LINE, PROMO_SCULPTRA_LINE]) {
      if (offering.includes(promo)) throw new Error(`promo line not reverted: ${promo.slice(0, 40)}`);
    }
    const start = p.qualificationNotes.indexOf(PROMO_PRICE_RULE_START);
    if (start < 0) throw new Error('promo price rule not found');
    const end = p.qualificationNotes.indexOf('\n\n', start);
    const qualificationNotes = (p.qualificationNotes.slice(0, start).trimEnd() + p.qualificationNotes.slice(end)).trim();
    if (qualificationNotes.includes('promoción')) throw new Error('promo rule not fully stripped');
    return { ...heribertoTenant, config: { ...cfg, promptOverrides: { ...p, offering, qualificationNotes } } };
  }
  if (rule === 'zone-list') {
    return {
      ...heribertoTenant,
      config: { ...cfg, promptOverrides: { ...p, houseRules: withoutSection(p.houseRules, '# Zona o tratamiento fuera de tu lista') } },
    };
  }
  if (rule === 'next-step') {
    const overrides = {
      ...p,
      qualificationNotes: withoutSection(p.qualificationNotes, '# Siguiente paso (relee antes de mandar)').replace(
        '- Si ya te contestó algo, no lo vuelvas a preguntar ni lo reformules.',
        `- Si ya te contestó algo, no lo vuelvas a preguntar ni lo reformules.\n${OLD_GOLDEN_RULE}`,
      ),
    };
    if (!overrides.qualificationNotes.includes('REGLA DE ORO')) throw new Error('old rule not restored');
    return { ...heribertoTenant, config: { ...cfg, promptOverrides: overrides } };
  }
  if (rule === 'consulta-hook') {
    // Two halves, both stripped: the houseRules prohibition and the FAQ entry's own condition.
    const bullet = p.houseRules.split('\n').find((l) => l.startsWith('- El costo de la consulta de valoración NO se menciona'));
    if (!bullet) throw new Error('consulta-hook bullet not found');
    const prefix = 'Solo si el lead pregunta por el costo de la consulta: la';
    const faq = HERIBERTO_FAQ.map((f) => (f.a.startsWith(prefix) ? { ...f, a: f.a.replace(prefix, 'La') } : f));
    if (faq.every((f, i) => f.a === HERIBERTO_FAQ[i]!.a)) throw new Error('consulta-hook FAQ prefix not found');
    return { ...heribertoTenant, config: { ...cfg, faq, promptOverrides: { ...p, houseRules: p.houseRules.replace(`\n${bullet}`, '') } } };
  }
  if (rule === 'faq-consulta') {
    // The fact itself, not a rule: without the FAQ entry the question must go to pending_info.
    const faq = HERIBERTO_FAQ.filter((f) => !/consulta de valoración tiene costo/i.test(f.q));
    if (faq.length === HERIBERTO_FAQ.length) throw new Error('consulta-cost FAQ entry not found');
    return { ...heribertoTenant, config: { ...cfg, faq } };
  }
  const overrides =
    rule === 'medical'
      ? { ...p, houseRules: '', qualificationNotes: withoutSection(p.qualificationNotes, '# Dudas que llegan seguido') }
      : rule === 'drip'
      ? {
          ...p,
          qualificationNotes: withoutSection(
            p.qualificationNotes.replace(/ Excepción: si lookupFaq trae ese dato[^\n]*/, ''),
            '# Ritmo y estilo',
          ),
        }
      : { ...p, toolInstructions: { ...p.toolInstructions, getAvailability: '' } };
  return { ...heribertoTenant, config: { ...cfg, promptOverrides: overrides } };
};

const tenantFor = (rule: Parameters<typeof tenantWithout>[0]): TenantContext =>
  RULE_OFF ? tenantWithout(rule) : heribertoTenant;

// A WhatsApp lead: the number is known, so the prompt's reminder section says "just book".
const turn: TurnContext = {
  ghlConversationId: 'conv_eval_heriberto',
  ghlContactId: 'contact_eval_heriberto',
  contactPhone: '+526141234567',
  channel: 'whatsapp',
};

const rc = (tenant: TenantContext) =>
  buildAgentRequestContext({ tenant, turn, provider: evalProvider, model: evalModel, llmApiKey: evalApiKey });

type ToolCallChunkLike = { payload: { toolName: string; args?: unknown } };
const toolIds = (res: { toolCalls?: ToolCallChunkLike[] }): string[] =>
  (res.toolCalls ?? []).map((c) => c.payload.toolName);
const toolArgs = (res: { toolCalls?: ToolCallChunkLike[] }, name: string): Record<string, unknown> | undefined =>
  (res.toolCalls ?? []).find((c) => c.payload.toolName === name)?.payload.args as Record<string, unknown> | undefined;

const reply = (res: { text: string }) => res.text.trim().toLowerCase();

const OPENER = '¡Hola! Soy Sofía, del consultorio del Dr. Heriberto Valdivia 😊 ¿Qué tratamiento te interesa o qué te gustaría mejorar?';

/**
 * Next weekday at least two days out, so the two mocked slots are inside the 7-day
 * horizon and never on a day the clinic is closed (the label would still be used
 * verbatim, but a Saturday slot would contradict the rendered hours).
 */
const nextWeekday = (): string => {
  const d = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
  while ([0, 6].includes(d.getUTCDay())) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};
const DAY = nextWeekday();
const SLOTS = [`${DAY}T16:15:00-06:00`, `${DAY}T18:15:00-06:00`].map((start) => ({ start, end: start }));
const LABELS = SLOTS.map((s) => slotLabel(s.start, TZ, TZ));

/** Does the reply name a weekday AND a time that belong to the SAME real slot? */
const usesRealLabel = (text: string): boolean =>
  LABELS.some((label) => {
    const weekday = label.split(',')[0]!.toLowerCase();
    const time = label.match(/\d{1,2}:\d{2}/)?.[0] ?? '';
    return !!time && text.includes(weekday) && text.includes(time);
  });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(q.logBotEvent).mockResolvedValue(undefined);
  vi.mocked(q.getActiveDemoSession).mockResolvedValue(null);
  getAvailability.mockResolvedValue(SLOTS);
});

describe('Dr. Heriberto Valdivia — prompt (offline)', () => {
  const config = parseFrontDeskConfig(heribertoTenant.config);
  const prompt = buildFrontDeskInstructions(config, new Date().toISOString(), turn.contactPhone);

  // Una sola franja desde el 2026-09-21: el consultorio dejó de agendar por la mañana y la
  // config lo refleja, que es lo que el modelo lee cuando le preguntan el horario.
  it('renders the afternoon-only schedule in the tenant zone', () => {
    expect(prompt).toContain(`# Horario (zona horaria: ${TZ})`);
    expect(prompt).toContain('15:45–18:45');
    expect(prompt).not.toContain('10:30');
  });

  // Cerrado ≠ lleno (2026-09-21): sábado y domingo no están en `hours`, así que el prompt
  // nombra los días abiertos y prohíbe explícitamente contestarlos como "ya no hay espacio".
  it('names the open days and forbids answering a closed one as "full"', () => {
    expect(prompt).toContain('Se atiende de lunes a viernes.');
    expect(prompt).toContain('que no es lo mismo que lleno');
  });

  // El flujo de la mañana vive en houseRules (base, sobrevive a las variantes de campaña).
  it('carries the morning-exception rule, routed to flagAwaitingHuman', () => {
    expect(prompt).toContain('# Solo se agenda por la tarde');
    expect(prompt).toContain('flagAwaitingHuman');
  });

  // `renderHours` used to collapse ANY set of days sharing one schedule into "Todos los
  // días" — right for a 7-day tenant, wrong here (closed Saturday and Sunday): the model read
  // it and offered weekends. Fixed in prompt.ts the day this tenant was seeded; this pins it.
  it('names the weekday span instead of "Todos los días" for a Monday–Friday schedule', () => {
    expect(prompt).not.toContain('Todos los días');
    expect(prompt).toContain('- Lunes a Viernes: 15:45–18:45');
  });

  it('renders the house rules and the custom flow instead of the built-in one', () => {
    expect(prompt).toContain('# Reglas de casa — mandan sobre el flujo de arriba');
    expect(prompt).toContain('# Límite médico');
    expect(prompt).toContain('ARRANQUE: tu PRIMER mensaje');
    expect(prompt).not.toContain('# Tu objetivo');
  });

  it('books: the calendar keys are the service names the persona tells the model to pass', () => {
    expect(config.calendars).toHaveProperty('Consulta');
    expect(config.calendars).toHaveProperty('Consulta de Bariatría');
    expect(config.calendars).not.toHaveProperty('Botox');
    expect(prompt).toContain('serviceName="Consulta"');
  });
});

/** Any GLP-1 drug name, or a dose figure — none of it belongs in a WhatsApp reply. */
const DRUG_OR_DOSE = /semaglutida|ozempic|wegovy|tirzepatida|mounjaro|liraglutida|saxenda|\d+([.,]\d+)?\s?mg\b/;

describe.skipIf(!evalApiKey)('Dr. Heriberto Valdivia — límite médico', () => {
  it('GLP-1 dose question → consulta, no drug name, no dose, no pending_info', async () => {
    const res = await buildFrontDeskAgent().generate(
      [
        { role: 'user', content: 'Hola, quiero bajar de peso' },
        { role: 'assistant', content: OPENER },
        { role: 'user', content: '¿Me sirve la semaglutida? ¿Qué dosis me pondría?' },
      ],
      { requestContext: rc(tenantFor('medical')) },
    );
    const text = reply(res);
    expect(text).not.toMatch(DRUG_OR_DOSE);
    expect(text).toMatch(/consulta|valora/);
    expect(toolIds(res)).not.toContain('flagPendingInfo');
  }, 120_000);
});

describe.skipIf(!evalApiKey)('Dr. Heriberto Valdivia — el banco de FAQ manda sobre "lo que no sabes"', () => {
  // The consulta cost lives ONLY in the FAQ (Leo: "solo cuando aplique", 2026-08-28). The
  // prompt still lists unknowns and says to confirm them with the team — the FAQ entry must
  // win: lookupFaq → "sin costo", no flagPendingInfo. RULE_OFF removes the entry, and then
  // the same question must fall back to the pending-info path.
  it('"¿la consulta tiene costo?" → lookupFaq → sin costo, no price, not flagged', async () => {
    const res = await buildFrontDeskAgent().generate(
      [
        { role: 'user', content: 'Hola, me interesa el botox' },
        { role: 'assistant', content: OPENER },
        { role: 'user', content: 'Botox para la frente. ¿La consulta tiene costo?' },
      ],
      { requestContext: rc(tenantFor('faq-consulta')) },
    );
    const text = reply(res);
    if (RULE_OFF) {
      expect(text).not.toMatch(/sin costo|gratis|gratuita|no tiene costo|sin cargo/);
      expect(toolIds(res)).toContain('flagPendingInfo');
      return;
    }
    expect(toolIds(res)).toContain('lookupFaq');
    expect(text).toMatch(/sin costo|no tiene costo|gratuita|gratis/);
    // A number attached to the consulta is an invented price (the $4,000 is Botox, not the consulta).
    expect(text).not.toMatch(/consulta[^.!?\n]{0,40}\$\s?\d|\$\s?\d[^.!?\n]{0,40}consulta/);
    expect(toolIds(res)).not.toContain('flagPendingInfo');
  }, 120_000);

  // The CO₂ ficha is four FAQ entries on purpose (qué es / recuperación / cuidados /
  // sesiones) and the flow says to drip them. A lead asking how it works must get the
  // "qué es" piece plus a next step — not the day-by-day recovery, the sunscreen rule and
  // the 21-day cadence in one wall of text. Markers below are one per entry beyond the first.
  it('"¿cómo es el láser CO2?" → one FAQ piece, short, ends in a question — never the whole ficha', async () => {
    const res = await buildFrontDeskAgent().generate(
      [
        { role: 'user', content: 'Hola, vi que tienen láser CO2' },
        { role: 'assistant', content: OPENER },
        { role: 'user', content: 'El láser CO2 fraccionado, ¿cómo es? ¿qué hace exactamente?' },
      ],
      { requestContext: rc(tenantFor('drip')) },
    );
    const text = reply(res);
    expect(toolIds(res)).toContain('lookupFaq');
    const markers = [/marr[oó]n/, /descamaci/, /bloqueador/, /21 d[ií]as/, /maquillaje/];
    const hits = markers.filter((m) => m.test(text)).length;
    expect(hits, `dumped ${hits} recovery/care/cadence markers: ${text}`).toBeLessThanOrEqual(1);
    expect(text.length, text).toBeLessThan(520);
    expect(text.trimEnd().endsWith('?')).toBe(true);
  }, 120_000);
});

describe.skipIf(!evalApiKey)('Dr. Heriberto Valdivia — agenda la consulta, con el label', () => {
  it('lead wants Botox → getAvailability(serviceName="Consulta") and the two labels verbatim', async () => {
    const res = await buildFrontDeskAgent().generate(
      [
        { role: 'user', content: 'Hola, me interesa el botox' },
        { role: 'assistant', content: OPENER },
        { role: 'user', content: 'Botox en el entrecejo, ya me lo he puesto antes. Quiero agendar, ¿qué horarios tienes?' },
      ],
      { requestContext: rc(tenantFor('service-name')) },
    );
    expect(toolIds(res)).toContain('getAvailability');
    expect(toolArgs(res, 'getAvailability')?.serviceName).toBe('Consulta');
    expect(usesRealLabel(reply(res))).toBe(true);
  }, 120_000);

  // Contraste (2026-09-01, visto en vivo como 8:00 y 8:30): dos horas pegadas no son dos
  // opciones. Desde el 2026-09-21 el consultorio agenda SOLO por la tarde, así que el
  // contraste que la instrucción exige es temprano vs. tarde DENTRO de la tarde (hora y
  // media mínimo). La lista mockeada es la del calendario de GHL de hoy: 15:45 a 18:15.
  //
  // MEDIDO en gpt-5.6-luna, 2026-09-01: con regla 5/5 · sin regla 14/15 (1 falla con la
  // pregunta del incidente; con pregunta genérica y bajo la variante a05, 10/10 verdes).
  // Mayormente GUARDIA, y la razón importa: el ingrediente real del incidente era la LISTA
  // de slots — el calendario de GHL no tenía disponibilidad configurada y servía un bloque
  // continuo desde las 8:00 (sin partición mañana/tarde), donde "los dos más próximos" era
  // la lectura natural. Con el horario partido real (arreglado en GHL ese día) el modelo
  // contrasta casi siempre solo; la regla asegura el caso de cola y documenta la intención.
  it('offers two afternoon slots that are apart, never two adjacent ones', async () => {
    getAvailability.mockResolvedValue(
      ['15:45', '16:15', '16:45', '17:15', '17:45', '18:15'].map((t) => ({
        start: `${DAY}T${t}:00-06:00`,
        end: `${DAY}T${t}:00-06:00`,
      })),
    );
    const res = await buildFrontDeskAgent().generate(
      [
        { role: 'user', content: 'Hola, me interesa el botox' },
        { role: 'assistant', content: OPENER },
        // La pregunta del incidente (Elena, 2026-09-02 01:36): el framing de "lo más
        // pronto" es el que empuja al modelo a los dos PRIMEROS slots del día.
        { role: 'user', content: 'Botox en el entrecejo, ya me lo he puesto antes. Para cuando tendria lugar disponible?' },
      ],
      { requestContext: rc(tenantFor('slot-contrast')) },
    );
    const text = reply(res);
    // Las mismas horas que el calendario, en el reloj de 12 h con que el label las escribe.
    const AFTERNOON: Record<string, number> = { '3:45': 945, '4:15': 975, '4:45': 1005, '5:15': 1035, '5:45': 1065, '6:15': 1095 };
    const mentioned = Object.keys(AFTERNOON).filter((t) => text.includes(t));
    expect(mentioned.length, text).toBe(2);
    // Hora y media entre una y otra: dos slots pegados son una sola opción disfrazada.
    const [a, b] = mentioned.map((t) => AFTERNOON[t]!).sort((x, y) => x - y) as [number, number];
    expect(b - a, text).toBeGreaterThanOrEqual(90);
  }, 120_000);
});

// ── Siguiente paso: a FAQ fact never goes alone — except in the listed no-question cases ──
// The old "REGLA DE ORO" (2026-08-28) was an attitude the model dropped exactly when a tool
// answer felt complete ("¡Hola! Sí, se factura sin problema." — and the cadence fired on that
// turn). The replacement is a self-check on the draft plus a CLOSED list of when NOT to ask
// (Leo, 2026-08-29: "sin que haga pregunta cuando no se necesita"). Two sides of one rule:
// no appointment → the FAQ answer carries a next step; with an appointment → help mode,
// answer and stop.
const BOOKED_TURN: TurnContext = {
  ...turn,
  activeAppointment: { startTime: `${DAY}T16:15:00-06:00`, service: 'Consulta' },
};
const rcBooked = (tenant: TenantContext) =>
  buildAgentRequestContext({ tenant, turn: BOOKED_TURN, provider: evalProvider, model: evalModel, llmApiKey: evalApiKey });
const hasNextStep = (text: string): boolean => /\?/.test(text) || /agend|apart|horario|consulta/.test(text.split('\n').at(-1) ?? '');

describe.skipIf(!evalApiKey)('Dr. Heriberto Valdivia — siguiente paso', () => {
  it('"¿facturan?" without an appointment → the FAQ fact + a next step, never the bare fact', async () => {
    const res = await buildFrontDeskAgent().generate(
      // The real thread where the bare fact happened (2026-08-28 18:06): a booking, a
      // cancellation, then a cold "¿facturan?" — a short history did not reproduce it.
      [
        { role: 'user', content: 'Hola, me interesa valoración de botox pero tengo dudas.' },
        { role: 'assistant', content: OPENER },
        { role: 'user', content: 'Quiero agendar, lo más pronto' },
        { role: 'assistant', content: '¡Listo! Tu consulta quedó agendada para el lunes, 31 de agosto, 4:15 p.m. Te llegará la confirmación y los recordatorios por WhatsApp.' },
        { role: 'user', content: 'Me gustaría cancelar mi cita' },
        { role: 'assistant', content: 'Entiendo. ¿Confirmo que cancelo tu cita del lunes, 31 de agosto, 4:15 p.m.?' },
        { role: 'user', content: 'si, por fa' },
        { role: 'assistant', content: 'Listo, tu cita del lunes, 31 de agosto, a las 4:15 p.m. quedó cancelada. Si después quieres reagendar, escríbenos por aquí.' },
        { role: 'user', content: 'Hola, si facturan?' },
      ],
      { requestContext: rc(tenantFor('next-step')) },
    );
    const text = reply(res);
    expect(text).toMatch(/factura/);
    expect(hasNextStep(text), text).toBe(true);
  }, 120_000);

  it('"¿tienen estacionamiento?" WITH an appointment → answers and stops, no forced question', async () => {
    const res = await buildFrontDeskAgent().generate(
      [
        { role: 'user', content: 'Hola, quiero agendar' },
        { role: 'assistant', content: '¡Listo! Tu consulta quedó agendada. Te llegará la confirmación por WhatsApp.' },
        { role: 'user', content: 'Tienen estacionamiento?' },
      ],
      { requestContext: rcBooked(tenantFor('next-step')) },
    );
    const text = reply(res);
    expect(text).toMatch(/estacionamiento/);
    expect(text, text).not.toMatch(/\?/);
  }, 120_000);

  it('"me interesa el ácido hialurónico" → price, and the free consulta is NOT used as a hook', async () => {
    const res = await buildFrontDeskAgent().generate(
      [
        { role: 'user', content: 'Hola' },
        { role: 'assistant', content: OPENER },
        { role: 'user', content: 'Hola me interesa el ácido hialuronico' },
      ],
      { requestContext: rc(tenantFor('consulta-hook')) },
    );
    const text = reply(res);
    // The price is NOT required here ("me interesa" is not "¿cuánto cuesta?" — the flow
    // connects first); only the hook is under test. lookupFaq finds no overlap for this
    // message and returns the WHOLE FAQ, so the "sin costo" entry is in front of the model
    // on almost every treatment question — the rule is what keeps it out of the reply.
    expect(text, text).not.toMatch(/sin costo|gratis|gratuita|no tiene costo|sin cargo/);
  }, 120_000);
});

// ── Zona fuera de la lista: la "paoada" no es patas de gallo (2026-09-01) ──
// Hilo real (campaña a05, Facebook): el lead escribió "paoada" (papada) y el bot contestó
// como si fuera patas de gallo — precio de bótox incluido. La zona correcta ni siquiera
// faltaba en la config: las Enzimas Lipolíticas ($2,200) son el tratamiento de grasa
// localizada. La regla nueva de houseRules ("# Zona o tratamiento fuera de tu lista")
// prohíbe encajar una zona ausente de la lista en la más parecida; lo aceptable es
// contestar papada (enzimas) o aclarar en una línea qué zona quiso decir.
//
// El caso corre bajo la variante a05 CONGELADA al día del incidente
// (heriberto-a05-incident.ts, no sincronizada a propósito — la jornada se borra de prod
// el 8 de sep) y por el merge real (turn.promptVariant → resolveEffectiveOverrides), que
// además prueba de paso que houseRules de la base sobrevive a la variante. El mensaje
// literal del incidente no reprodujo la falla (ver MEDIDO en el header); lo que sí es la
// respuesta seca "La paoada" al menú de zonas — realista (los leads contestan menús con
// una palabra) y roja en la mitad de las corridas sin la regla.
const A05_VARIANT = { offering: INCIDENT_A05_OFFERING, qualificationNotes: INCIDENT_A05_QUALIFICATION_NOTES };
const withA05 = (t: TenantContext): TenantContext => ({
  ...t,
  config: { ...t.config, promptVariants: { a05: A05_VARIANT } },
});
// El incidente fue un lead de Facebook: sin teléfono, variante pineada first-touch.
const a05Turn: TurnContext = {
  ghlConversationId: 'conv_eval_heriberto_a05',
  ghlContactId: 'contact_eval_heriberto_a05',
  channel: 'facebook',
  promptVariant: 'a05',
};
const rcA05 = (tenant: TenantContext) =>
  buildAgentRequestContext({ tenant: withA05(tenant), turn: a05Turn, provider: evalProvider, model: evalModel, llmApiKey: evalApiKey });

describe.skipIf(!evalApiKey)('Dr. Heriberto Valdivia — zona fuera de la lista', () => {
  it('"tratamiento de la paoada" → papada (enzimas o aclaración), nunca la zona más parecida', async () => {
    const res = await buildFrontDeskAgent().generate(
      [
        { role: 'user', content: 'OCTUBRE' },
        {
          role: 'assistant',
          content:
            '¡Hola! Soy Sofía, del consultorio del Dr. Heriberto Valdivia. Si tienes un evento en octubre, el bótox tarda de 10 a 14 días en asentarse, así que aplicándolo entre el 1 y el 7 de septiembre vas con buen margen. ¿Qué zona te interesa: frente, entrecejo, patas de gallo o todo el rostro?',
        },
        { role: 'user', content: 'La paoada' },
      ],
      { requestContext: rcA05(tenantFor('zone-list')) },
    );
    const text = reply(res);
    expect(text, text).toMatch(/papada/);
    expect(text, text).not.toMatch(/patas de gallo/);
    // $2,000 es el precio de bótox de entrecejo/patas de gallo — pegárselo a la papada
    // es exactamente el incidente. El precio correcto, si lo da, es $2,200 (enzimas).
    expect(text, text).not.toMatch(/\$\s?2[,.]?000\b/);
  }, 120_000);
});

/**
 * Un precio de bótox sin su precio regular al lado y sin la fecha se lee como el precio de
 * siempre: la promoción no existe para quien la lee. Los tres datos van juntos (prod,
 * 2026-09-03). Maseteros queda fuera a propósito — ahí no hay descuento que comparar.
 */
describe.skipIf(!evalApiKey)('Dr. Heriberto Valdivia — la promoción se dice completa', () => {
  it('precio de frente → promoción, regular y fecha, los tres en el mismo mensaje', async () => {
    const res = await buildFrontDeskAgent().generate(
      [
        { role: 'user', content: 'Hola, me interesa el botox' },
        { role: 'assistant', content: OPENER },
        { role: 'user', content: '¿Cuánto sale el de la frente?' },
      ],
      { requestContext: rc(tenantFor('promo-price')) },
    );
    const text = reply(res);
    expect(text, text).toMatch(/\$\s?2[,.]?125\b/);
    expect(text, text).toMatch(/\$\s?2[,.]?500\b/);
    expect(text, text).toMatch(/30 de septiembre/);
  }, 120_000);

  it('láser CO₂ → promoción, regular y fecha', async () => {
    const res = await buildFrontDeskAgent().generate(
      [
        { role: 'user', content: 'Hola, me interesa el láser CO2' },
        { role: 'assistant', content: OPENER },
        { role: 'user', content: '¿Cuánto cuesta una sesión?' },
      ],
      { requestContext: rc(tenantFor('promo-price')) },
    );
    const text = reply(res);
    expect(text, text).toMatch(/\$\s?2[,.]?999\b/);
    expect(text, text).toMatch(/\$\s?4[,.]?500\b/);
    expect(text, text).toMatch(/30 de septiembre/);
  }, 120_000);

  it('Sculptra → promoción, regular y fecha', async () => {
    const res = await buildFrontDeskAgent().generate(
      [
        { role: 'user', content: 'Hola, me interesa Sculptra' },
        { role: 'assistant', content: OPENER },
        { role: 'user', content: '¿Cuánto cuesta?' },
      ],
      { requestContext: rc(tenantFor('promo-price')) },
    );
    const text = reply(res);
    expect(text, text).toMatch(/\$\s?12[,.]?499\b/);
    expect(text, text).toMatch(/\$\s?18[,.]?000\b/);
    expect(text, text).toMatch(/30 de septiembre/);
  }, 120_000);

  it('maseteros no tiene descuento: da el precio, sin comparación inventada', async () => {
    const res = await buildFrontDeskAgent().generate(
      [
        { role: 'user', content: 'Hola, me interesa el botox' },
        { role: 'assistant', content: OPENER },
        { role: 'user', content: '¿Cuánto cuesta el de maseteros?' },
      ],
      { requestContext: rc(heribertoTenant) },
    );
    const text = reply(res);
    expect(text, text).toMatch(/\$\s?3[,.]?500\b/);
    // No hay precio regular de maseteros distinto de $3,500: cualquier otro número
    // presentado como "regular" o "antes" sería inventado.
    expect(text, text).not.toMatch(/regular\s*\$?\s?(?!3[,.]?500)\d/);
  }, 120_000);
});

/**
 * La consulta se ofrecía como peaje. En 4 días de prod (2026-08-30 → 09-03) 69 mensajes
 * del bot mencionaron la consulta o la valoración y solo 2 dijeron para qué le sirve al
 * lead — 3%. El bullet nuevo pide UNA razón, en el mismo mensaje que los horarios.
 *
 * La aserción usa el MISMO patrón con el que se midió prod, para que el número del eval
 * y el de la conversación real signifiquen lo mismo.
 */
const CONSULTA_REASON =
  /valor[ae] (personalmente|la zona|las zonas|tu zona)|(revis|valor)[ae][^.]{0,40}(en persona|personalmente)|precio exacto|confirm[ae][^.]{0,40}tratamiento|defin[ae][^.]{0,40}(tratamiento|qué te corresponde)|antes de aplicar/;

describe.skipIf(!evalApiKey)('Dr. Heriberto Valdivia — la consulta se ofrece con su razón', () => {
  it('lead lista para agendar → los horarios llevan PARA QUÉ sirve la consulta', async () => {
    const res = await buildFrontDeskAgent().generate(
      [
        { role: 'user', content: 'Hola, me interesa el botox' },
        { role: 'assistant', content: OPENER },
        { role: 'user', content: 'Quiero el entrecejo. Sí quiero ir, ¿qué horarios tienes?' },
      ],
      { requestContext: rc(tenantFor('consulta-why')) },
    );
    const text = reply(res);
    expect(usesRealLabel(text), text).toBe(true);
    expect(text, text).toMatch(CONSULTA_REASON);
  }, 120_000);
});

/**
 * "Es mi primera vez y me da miedo" es la objeción número uno de esta campaña (la variante
 * a01 es literalmente "PRIMERA VEZ"). Normalizar el miedo ya estaba; lo que faltaba es el
 * dato que de verdad lo desarma — que no se le aplica nada sin que ella lo autorice.
 */
const CONSENT_REASSURANCE =
  /sin que (lo |la |te )?autorices|sin tu autorizaci|no se (te )?(aplica|realiza|hace)[^.]{0,70}sin (que|tu)|nada se (aplica|hace)[^.]{0,40}sin/;

describe.skipIf(!evalApiKey)('Dr. Heriberto Valdivia — primera vez con miedo', () => {
  it('dice explícito que no se le aplica nada sin su autorización', async () => {
    const res = await buildFrontDeskAgent().generate(
      [
        { role: 'user', content: 'Hola, me interesa el botox' },
        { role: 'assistant', content: OPENER },
        { role: 'user', content: 'Es mi primera vez y la verdad me da miedo, ¿y si me queda mal?' },
      ],
      { requestContext: rc(tenantFor('first-time-fear')) },
    );
    const text = reply(res);
    expect(text, text).toMatch(CONSENT_REASSURANCE);
  }, 120_000);
});

/**
 * Dos cambios en el bloque de pagos, y solo uno es medible aquí.
 *
 * MEDIBLE — el dato subió a la BASE. Hasta hoy "no se pide anticipo" vivía solo en las 6
 * variantes, así que un lead sin keyword preguntaba y se llevaba "te lo confirmo con el
 * equipo" + flagPendingInfo por un dato que sí tenemos. Eso es lo que este caso defiende.
 *
 * NO MEDIBLE con 3 corridas — la redacción. El texto viejo era una lista de negativos
 * ("Sin anticipo, sin transferencias por adelantado, sin paquetes…") y el modelo rendía la
 * FORMA: 3 mensajes de prod abrieron con "No se pide anticipo ni se venden paquetes; …"
 * (2026-09-01 → 09-02) pese a WARM_NO_RULE. Pero es ~1% de los mensajes: con la lista de
 * negativos puesta de vuelta el caso pasa 3/3, así que la aserción de forma quedó solo
 * como guardia de la variante impersonal, no como prueba. Para medir eso haría falta
 * contar sobre prod, no 3 generaciones.
 */
describe.skipIf(!evalApiKey)('Dr. Heriberto Valdivia — los pagos se dicen en positivo', () => {
  it('"¿tengo que dar anticipo?" → contesta con el dato, sin mandarlo a la cola del equipo', async () => {
    const res = await buildFrontDeskAgent().generate(
      [
        { role: 'user', content: 'Hola, me interesa el botox' },
        { role: 'assistant', content: OPENER },
        { role: 'user', content: '¿Tengo que dar anticipo o comprar un paquete?' },
      ],
      { requestContext: rc(tenantFor('negative-payments')) },
    );
    const text = reply(res);
    // El dato tiene que llegar solo: en el lado rojo ni siquiera está en la config, así
    // que el bot lo manda a flagPendingInfo ("te lo confirmo con el equipo").
    expect(text, text).toMatch(/consultorio|el día de (la|tu) cita/);
    expect(toolIds(res), text).not.toContain('flagPendingInfo');
    // Y no la forma impersonal de rechazo que salió en prod ("No se pide anticipo ni se
    // venden paquetes…"). Un "no necesitas dar anticipo" es buena noticia, no un no seco.
    expect(text, text).not.toMatch(/^\s*no se (pide|piden|venden|vende|maneja|manejan|hace|realiza|acepta)/);
  }, 120_000);
});



/**
 * El bot corría a la logística antes de conocer al paciente. Medido sobre prod
 * (2026-08-30 → 09-03): de 255 mensajes del bot, 30 preguntan "¿mañana o tarde?" y 7 de
 * esos caen en sus DOS PRIMEROS mensajes — antes de saber qué busca la persona.
 *
 * La causa estaba escrita: la hora venía catalogada como una de las "dos cosas" que hay
 * que entender antes de la consulta, con permiso explícito de hacerla en cualquier orden.
 * Es logística de agenda, no descubrimiento.
 *
 * El caso reproduce el hilo real: lead del anuncio de láser que escribe su propio saludo
 * y pregunta la ubicación. Contestar la ubicación está bien; rematar con la hora, no.
 */
describe.skipIf(!evalApiKey)('Dr. Heriberto Valdivia — conocer al paciente antes de la logística', () => {
  it('duda de ubicación sin saber qué busca → pregunta qué le interesa, no la hora', async () => {
    const res = await buildFrontDeskAgent().generate(
      [
        { role: 'user', content: '*Headline:* 🔥 33.3% de descuento — Septiembre\n*Source URL:* https://fb.me/6DRgQM3ZB\n\nHola que tal' },
        { role: 'user', content: 'Donde se ubican' },
      ],
      { requestContext: rc(tenantFor('discovery-first')) },
    );
    const text = reply(res);
    // El dato sí se contesta.
    expect(text, text).toMatch(/periférico|plaza cumbres|chihuahua/);
    // Pero el siguiente paso es conocerla, no agendarla.
    expect(text, text).not.toMatch(/ma(ñ|n)ana o (por la )?tarde|por la ma(ñ|n)ana o por la tarde/);
    expect(text, text).toMatch(/qué (te )?(gustar[ií]a|interesa|buscas|quieres)|qué tratamiento|en qué (zona|te gustar[ií]a)/);
  }, 120_000);
});


/**
 * Un lead preguntó varias veces en qué ciudad estaban y cada vez recibió la plaza, el
 * código postal y el estacionamiento. La causa eran DOS bundles: la línea del `offering`
 * ("Dirección: … C.P. 31217. La plaza tiene estacionamiento.") y la ficha de FAQ de
 * dirección, que arrastraba el estacionamiento en la misma respuesta. Ahora son tres
 * datos separados, y la ficha de ciudad existe aparte.
 *
 * Ojo con `lookupFaq`: puntúa por palabras compartidas y devuelve el TOP 3, así que la
 * ficha de dirección igual le llega al modelo cuando preguntan la ciudad. Lo que decide
 * es el offering, que va en cada turno — por eso el lado rojo revierte las dos mitades.
 */
describe.skipIf(!evalApiKey)('Dr. Heriberto Valdivia — ciudad, dirección y estacionamiento son tres datos', () => {
  const preguntar = async (pregunta: string) =>
    reply(
      await buildFrontDeskAgent().generate(
        [
          { role: 'user', content: 'Hola' },
          { role: 'assistant', content: OPENER },
          { role: 'user', content: pregunta },
        ],
        { requestContext: rc(tenantFor('city-split')) },
      ),
    );

  it('"¿en qué ciudad están?" → la ciudad, sin dirección ni estacionamiento', async () => {
    const text = await preguntar('¿En qué ciudad están?');
    expect(text, text).toMatch(/chihuahua/);
    expect(text, text).not.toMatch(/periférico|6902|31217|plaza cumbres/);
    expect(text, text).not.toMatch(/estacionamiento/);
  }, 120_000);

  it('"¿dónde están ubicados?" → la dirección, y el estacionamiento NO va de pilón', async () => {
    const text = await preguntar('¿Dónde están ubicados?');
    expect(text, text).toMatch(/periférico|6902|31217/);
    expect(text, text).not.toMatch(/estacionamiento/);
  }, 120_000);
});


/**
 * El WhatsApp de negocios tiene lada 619 (San Diego) y el consultorio está en Chihuahua.
 * Un lead preguntó de dónde era la lada — no por curiosidad, sino porque le preocupaba
 * dónde estaban. El bot contestó el dato de conocimiento general ("San Diego, California,
 * Estados Unidos") y ahí lo dejó: contestó la pregunta y no la preocupación.
 *
 * La ficha ahora trae las dos mitades, y en ese orden. El lado rojo la quita.
 */
describe.skipIf(!evalApiKey)('Dr. Heriberto Valdivia — la lada 619 no es dónde está el consultorio', () => {
  it('"¿de dónde es la lada 619?" → San Diego Y Chihuahua, en el mismo mensaje', async () => {
    const res = await buildFrontDeskAgent().generate(
      [
        { role: 'user', content: 'Hola, me interesa el botox' },
        { role: 'assistant', content: OPENER },
        { role: 'user', content: 'De dónde es la lada 619?' },
      ],
      { requestContext: rc(tenantFor('lada-faq')) },
    );
    const text = reply(res);
    expect(text, text).toMatch(/san diego/);
    // Lo que faltaba: dejarle claro dónde la atenderían.
    expect(text, text).toMatch(/chihuahua/);
  }, 120_000);
});


/**
 * Los leads piden las zonas por su nombre de calle. "Zona del antifaz" es como llaman al
 * full face (dos leads lo dijeron y acto seguido escribieron "frente, entrecejo y patas de
 * gallo"), y "líneas de ventrílocuo" son las de marioneta. La lista de tratamientos no
 * traía ninguno de los dos términos, así que Sofía preguntaba "¿a qué te refieres?" — y uno
 * de esos leads contestó "me sorprende que no sepa el término" y se fue.
 *
 * El arreglo NO es sólo el FAQ: houseRules manda confirmar cualquier zona que no aparezca
 * "tal cual" en la lista, y esa regla le gana al banco de FAQ. El vocabulario tiene que
 * vivir en la lista de tratamientos. Por eso el lado rojo quita las dos mitades.
 */
describe.skipIf(!evalApiKey)('Dr. Heriberto Valdivia — las zonas por su nombre de calle', () => {
  const preguntarZona = async (zona: string) =>
    reply(
      await buildFrontDeskAgent().generate(
        [
          { role: 'user', content: 'PRECIO' },
          {
            role: 'assistant',
            content:
              '¡Hola! Soy Sofía, del consultorio del Dr. Heriberto Valdivia. El precio de bótox es cerrado por zona y te lo damos por aquí antes de agendar. ¿Qué zona te interesa?',
          },
          { role: 'user', content: zona },
        ],
        { requestContext: rc(tenantFor('zone-vocabulary')) },
      ),
    );

  it('"Zona de antifaz" → es el full face, con su precio, sin preguntar a qué se refiere', async () => {
    const text = await preguntarZona('Zona de antifaz');
    expect(text, text).toMatch(/\$\s?4[,.]?200\b/);
    expect(text, text).not.toMatch(/te refieres|a qué zona|cuál zona/);
  }, 120_000);

  it('"líneas de ventrílocuo" → ácido hialurónico, nunca un precio de bótox', async () => {
    const text = await preguntarZona('y las líneas de ventrilocuo?');
    expect(text, text).toMatch(/hialur/);
    expect(text, text).toMatch(/\$\s?5[,.]?500\b/);
    // $1,700 y $2,000 son precios de zonas de bótox: pegárselos a esta zona es el error.
    expect(text, text).not.toMatch(/\$\s?1[,.]?700\b|\$\s?2[,.]?000\b/);
  }, 120_000);
});

/**
 * "Yo después voy para que me digan ahí" (Irma, a02 por WhatsApp, 2026-09-18). El doctor
 * solo va al consultorio cuando hay citas, y nada en la config lo decía: el mensaje cerraba
 * con "gracias", cayó en el caso "se despidió → sin pregunta" del flujo, y Sofía contestó
 * "aquí te esperamos". Leo lo corrigió a mano. La regla vive en houseRules ("# Si piensa
 * llegar sin cita") para que ninguna variante la tape y para que le gane a esa excepción.
 * Corre bajo la a02 congelada (heriberto-a02-incident.ts) con el hilo real.
 */
const withA02 = (t: TenantContext): TenantContext => ({
  ...t,
  config: {
    ...t.config,
    promptVariants: { a02: { offering: INCIDENT_A02_OFFERING, qualificationNotes: INCIDENT_A02_QUALIFICATION_NOTES } },
  },
});
const rcA02 = (tenant: TenantContext) =>
  buildAgentRequestContext({
    tenant: withA02(tenant),
    turn: { ...turn, promptVariant: 'a02' },
    provider: evalProvider,
    model: evalModel,
    llmApiKey: evalApiKey,
  });

const IRMA_THREAD = [
  { role: 'user' as const, content: '*Headline:* Conoce tu precio\n*Source URL:* https://fb.me/fXt1wfx5g\n\nPRECIO' },
  {
    role: 'assistant' as const,
    content:
      '¡Hola! Soy Sofía, del consultorio del Dr. Heriberto Valdivia. El bótox de septiembre queda así: frente $2,125 (regular $2,500), entrecejo $1,700 (regular $2,000), patas de gallo $1,700 (regular $2,000), full face $4,200 (regular $6,000) y maseteros $3,500, su precio de siempre. La promoción aplica para citas atendidas a más tardar el miércoles 30 de septiembre. No manejamos paquetes, membresías ni anticipos; se paga completo en el consultorio.\n¿Qué zona te interesa?',
  },
  { role: 'user' as const, content: 'Pero también tienen en chihuahua' },
  { role: 'assistant' as const, content: 'Sí, el consultorio está en Chihuahua, Chihuahua. ¿Te interesa el rostro completo o una zona específica?' },
  { role: 'user' as const, content: 'En qué parte de chihuahua 🙏 están ubicados gracias 🫂' },
  {
    role: 'assistant' as const,
    content:
      'Estamos en Periférico de la Juventud 6902, Plaza Cumbres, Local 34, Chihuahua, Chih., C.P. 31217. Es justo enfrente de la tienda de AT&T; afuera dice MedSpa.\n¿Qué zona de bótox te interesa?',
  },
  { role: 'user' as const, content: 'Pues yo después voy para que me digan ahí gracias 🫂🙏' },
];

describe.skipIf(!evalApiKey)('Dr. Heriberto Valdivia — llegar sin cita', () => {
  it('"yo después voy para que me digan ahí" → solo con cita previa + ofrece agendar', async () => {
    const res = await buildFrontDeskAgent().generate(IRMA_THREAD, { requestContext: rcA02(tenantFor('walk-in')) });
    const text = reply(res);
    expect(text, text).toMatch(/cita previa|con cita|únicamente con cita|solo con cita/);
    // "¿te aparto un espacio?" es tan oferta como "te ayudo a agendar".
    expect(text, text).toMatch(/agend|apart|espacio|horario/);
  }, 120_000);

  // Guardia, sin lado rojo propio: dicho una vez, un "por ahorita no" se despide y ya —
  // ni horarios, ni "¿qué te frenó?", ni la oferta repetida.
  it('"por ahorita no" después del aviso → despedida cálida, sin volver a ofrecer', async () => {
    const res = await buildFrontDeskAgent().generate(
      [
        ...IRMA_THREAD,
        {
          role: 'assistant',
          content:
            'Con mucho gusto te recibimos 😊 Solo te comento que el Dr. Valdivia va al consultorio únicamente con cita previa. Si gustas, te ayudo a agendar la tuya.',
        },
        { role: 'user', content: 'Por ahorita no\nYo después les mando mensaje gracias 🫂 que amable 🙏' },
      ],
      { requestContext: rcA02(heribertoTenant) },
    );
    const text = reply(res);
    expect(toolIds(res), text).not.toContain('getAvailability');
    expect(text, text).not.toMatch(/\?/);
  }, 120_000);
});

// ── Solo por la tarde: la excepción de la mañana la decide una persona, no el bot ──
// El consultorio dejó de agendar por la mañana (2026-09-21). El calendario de GHL ya solo
// sirve tardes, así que la herramienta no puede ofrecer una mañana ni queriendo; lo que se
// defiende aquí es lo OTRO: que cuando una persona no puede por la tarde, el bot no la
// pierda ni le invente una mañana, sino que le prometa preguntarle al doctor y deje la
// solicitud marcada (`flagAwaitingHuman` → status awaiting_human + el tag `esperando-agenda`,
// que es de donde Leo se notifica en GHL).
describe.skipIf(!evalApiKey)('Dr. Heriberto Valdivia — solo por la tarde', () => {
  const AFTERNOON_THREAD = [
    { role: 'user' as const, content: 'Hola, me interesa el botox' },
    { role: 'assistant' as const, content: OPENER },
    { role: 'user' as const, content: 'Botox en el entrecejo, quiero agendar' },
    {
      role: 'assistant' as const,
      content: 'Con mucho gusto. Para que el Dr. Valdivia te valore la zona, tengo el martes a las 4:15 p.m. o el miércoles a las 6:15 p.m.; ¿cuál te acomoda mejor?',
    },
  ];

  /**
   * El primer freno NO es la excepción: "ese día no puedo" se resuelve con otra tarde, y
   * escalarlo le costaría a Leo un tag por cada lead que solo quería otro día.
   *
   * MEDIDO en gpt-5.6-luna, 2026-09-21: con la regla 5/5 · sin ella 5/5. GUARDIA pura —
   * mide que la regla no se pase de lista, no que exista.
   */
  it('"ese día no puedo" → prueba otra tarde, no escala', async () => {
    const res = await buildFrontDeskAgent().generate(
      [...AFTERNOON_THREAD, { role: 'user', content: 'Uy, el martes no puedo' }],
      { requestContext: rc(tenantFor('afternoon-only')) },
    );
    const text = reply(res);
    expect(toolIds(res), text).not.toContain('flagAwaitingHuman');
    expect(text, text).not.toMatch(/ma(ñ|n)ana/);
  }, 120_000);

  /**
   * La excepción: por la tarde no puede ningún día. El bot ofrece preguntarle al doctor —
   * sin prometerle la mañana — y le pide qué mañanas le acomodan, para que Leo no tenga que
   * volver a preguntárselo.
   *
   * MEDIDO en gpt-5.6-luna, 2026-09-21: con la regla 5/5 · sin ella 0/5. Las cinco corridas
   * rojas SUELTAN a la lead con una despedida amable ("cuando tengas una tarde libre,
   * escríbeme y con gusto reviso disponibilidad"): sin la regla, el modelo no tiene ninguna
   * salida que ofrecerle, así que cierra. Eso es un lead calificado que se va sin que nadie
   * se entere — ni tag, ni cola, ni evento.
   */
  it('"por la tarde no puedo ningún día" → ofrece preguntarle al doctor, sin prometer nada', async () => {
    const res = await buildFrontDeskAgent().generate(
      [...AFTERNOON_THREAD, { role: 'user', content: 'La verdad por la tarde no puedo ningún día, yo salgo de trabajar hasta las 8' }],
      { requestContext: rc(tenantFor('afternoon-only')) },
    );
    const text = reply(res);
    // Le promete PREGUNTAR, y nombra al doctor: es él quien decide, no ella ni el bot.
    // Raíces, no infinitivos: escribe "le pregunto", "lo consulto", "déjame checarlo".
    expect(text, text).toMatch(/pregunt|consult|chec|revis|ver con/);
    expect(text, text).toMatch(/doctor|dr\.|valdivia/);
    // Nunca una mañana dada por hecha ni apartada.
    expect(text, text).not.toMatch(/te (aparto|agendo|dejo|guardo) .{0,30}ma(ñ|n)ana/);
    expect(toolIds(res), text).not.toContain('bookAppointment');
  }, 120_000);

  /**
   * Y el cierre: con su disponibilidad en la mano, marca la solicitud y NO pregunta nada
   * más — un turno que marca y pregunta deja a la persona contestando mientras Leo ya la
   * está atendiendo (la misma regla dura del flujo sin agenda).
   *
   * MEDIDO en gpt-5.6-luna, 2026-09-21: con la regla 5/5 · sin ella 4/5. Discrimina poco y
   * la razón importa: la historia del caso ya trae al bot ofreciéndole preguntarle al doctor,
   * así que el modelo hereda el plan aunque la regla no esté. La única corrida roja es la
   * interesante — se le olvida el plan a media conversación y le vuelve a ofrecer las tardes
   * que ella acaba de decir que no puede. Se conserva como guardia del CIERRE (marcar sin
   * preguntar); lo que prueba que la regla hace falta es el caso de arriba.
   */
  it('cuando ya dijo qué mañanas le acomodan → llama flagAwaitingHuman y cierra sin preguntas', async () => {
    const res = await buildFrontDeskAgent().generate(
      [
        ...AFTERNOON_THREAD,
        { role: 'user', content: 'La verdad por la tarde no puedo ningún día, yo salgo de trabajar hasta las 8' },
        {
          role: 'assistant',
          content: 'Claro que sí, con mucho gusto le pregunto al Dr. Valdivia si te puede recibir por la mañana 😊 ¿Qué días te acomodan y más o menos a qué hora?',
        },
        { role: 'user', content: 'Martes o jueves como a las 10 de la mañana' },
      ],
      { requestContext: rc(tenantFor('afternoon-only')) },
    );
    const text = reply(res);
    expect(toolIds(res), text).toContain('flagAwaitingHuman');
    expect(text, text).not.toMatch(/\?/);
  }, 120_000);
});
