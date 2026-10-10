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
 *     (facturación, the enzimas and láser CO₂ fichas) live in `faq`, not in the prompt.
 *     The CO₂ ficha is four entries on purpose, and the drip case proves a "¿cómo es?"
 *     gets ONE piece, not the wall.
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
 *   - agenda "Consulta":  con regla 3/3 · sin regla (toolInstructions.getAvailability fuera) 0/3
 *   MEDIDO 2026-10-09 (gpt-5.6-luna, "El precio es el momento" → horarios en el mismo turno):
 *   - precio de la valoración con el caso ya dicho: con el texto vivo 4/4 (getAvailability + $500 +
 *     label real) · con el texto anterior (`HERIBERTO_RULE_OFF=1`) 1/4 — las 3 fallas contestan los
 *     $500 y preguntan "¿te aparto un espacio?", el patrón exacto de los 8 hilos de lp5 que murieron
 *     ahí en octubre. Tasa, no interruptor: el modelo a veces ya ofrecía horarios solo.
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
 *   MEDIDO 2026-10-08 (precios sin promo vencida): HERIBERTO_RULE_OFF=1 devuelve la promo de
 *     septiembre a la lista y al FAQ, como estuvo en prod hasta hoy.
 *   - "¿tienen promociones?": con la línea "Promociones: por ahora la única…" 5/5 · con la
 *     promo quitada pero SIN esa línea 0/3 — "déjame confirmar con el equipo si hay alguna
 *     promoción vigente para botox": quitar la promo dejó al modelo sin saber que no hay, y lo
 *     mandaba a la cola. Con la promo vieja restaurada 2/3 (también nombraba el láser).
 *   - frente $2,500: 8/8 · promo vieja 3/3 — no discrimina: el modelo sabe la fecha y ya no
 *     citaba la promo vencida. Sculptra $18,000: 8/8 · promo vieja 1/3. Maseteros: guardia.
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
 *   MEDIDO 2026-10-05 (oferta del láser: $4,500 / $3,500 a 14 días / evaluación $500):
 *   - con la oferta 3/3 · sin ella (línea, sección del offering y fichas con $3,500) 0/3: el
 *     rojo da $4,500 + evaluación de $500 y nunca el precio especial.
 *   - Ese mismo día los casos de promo de bótox y Sculptra fallan 1–2/3 en VERDE sin tocarlos:
 *     el modelo sabe la fecha y dice "la promoción de septiembre ya terminó". Es la promo
 *     vencida que sigue en la config, no una regresión de este cambio.
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
 *   MEDIDO 2026-09-30 (pedir la mañana ya es la excepción, sin pasar por otras tardes):
 *   - "No tiene horario en la mañana" (prod) y "¿y en la mañana no hay? me queda mejor": con
 *     la regla nueva 5/5 cada uno · con la anterior (`morning-ask`) 0/5 — las diez rojas son
 *     el mensaje de prod: "el consultorio agenda únicamente por la tarde" + las mismas tardes.
 *   - "ese día no puedo" sigue 5/5 (no escala) y "ningún día" 15/16 con la regla nueva; la
 *     roja salió en una corrida en paralelo y no se repitió en 15 seriales.
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
 * The pre-2026-09-30 morning rule — the red side of the "¿tienen en la mañana?" cases. It
 * read every objection as "try another afternoon first", so a lead who asked for the morning
 * was told the office only books afternoons and got the same slots again.
 */
const OLD_MORNING_WORDING = [
  `- Si el horario que le ofreciste no le acomoda por el día o la hora ("ese día no puedo", "¿más tarde?"), prueba con otras tardes: pregúntale qué día le viene mejor y vuelve a consultar. La mayoría se resuelve ahí.
- Si lo que pide es la mañana — pregunta si hay horario en la mañana, dice que la prefiere o que por la tarde no puede —, no le insistas con las tardes ni le expliques que solo se agenda por la tarde: ve directo a ofrecerle preguntarle al doctor. Dile`,
  `- Si el horario que le ofreciste no le acomoda, primero prueba con otras tardes: pregúntale qué día le viene mejor y vuelve a consultar. La mayoría se resuelve ahí.
- Solo cuando te diga claramente que por la tarde NO puede ningún día, ofrécele preguntarle al doctor: dile`,
] as const;

/**
 * The September promo, as prod still carried it until 2026-10-08 — the red side of the
 * "sin promo vencida" cases. Each pair is [now, before]: the list prices in `offering` and the
 * two FAQ answers that quoted the promo. Every pair must be found, or the swap throws.
 */
const STALE_PROMO_SWAPS: Array<[string, string]> = [
  [
    '- Botox por zona: frente $2,500, entrecejo $2,000, patas de gallo $2,000, maseteros $3,500; full face (frente, entrecejo y patas de gallo) $6,000.',
    '- Botox — precio de promoción de septiembre, por zona: frente $2,125 (regular $2,500), entrecejo $1,700 (regular $2,000), patas de gallo $1,700 (regular $2,000), maseteros $3,500 (su precio de siempre); full face (frente, entrecejo y patas de gallo) $4,200 (regular $6,000). La promoción aplica a las citas que se atienden a más tardar el miércoles 30 de septiembre.',
  ],
  [
    '- Sculptra — $18,000 por vial o sesión; el tratamiento completo de 3 viales son $30,000.',
    '- Sculptra — precio de promoción de septiembre: $12,499 por vial o sesión (regular $18,000); el tratamiento completo de 3 viales son $30,000.',
  ],
  ['El vial o sesión cuesta $18,000;', 'Durante septiembre el vial o sesión está en $12,499 (regular $18,000);'],
  [
    'Por ahora la única promoción es el precio especial del láser CO₂: $3,500 por sesión en todo el tratamiento en lugar de $4,500, si inicia dentro de los 14 días siguientes a su evaluación. Con tarjeta siempre hay 3 meses sin intereses.',
    'En septiembre hay promoción en dos tratamientos, para citas que se atienden a más tardar el miércoles 30 de septiembre. Bótox: frente $2,125 (regular $2,500), entrecejo $1,700 (regular $2,000), patas de gallo $1,700 (regular $2,000) y full face $4,200 (regular $6,000); maseteros se queda en su precio de siempre, $3,500. Sculptra: $12,499 por vial (regular $18,000), y el tratamiento completo de 3 viales sale en $30,000. En láser CO₂ fraccionado hay precio especial: $3,500 por sesión (normal $4,500) si inicia dentro de los 14 días siguientes a su evaluación médica de láser. Los demás tratamientos mantienen su precio de lista, y siempre hay 3 meses sin intereses con tarjeta.',
  ],
];

/** El láser: precio normal, precio especial a 14 días y evaluación de $500 (prod, 2026-10-05). */
const LASER_OFFER_LINE =
  '- Láser CO₂ Fraccionado — $4,500 por sesión, o $3,500 por sesión con el precio especial (ver "Láser CO₂: evaluación médica y precio especial").';
const LASER_LIST_PRICE_LINE = '- Láser CO₂ Fraccionado — $4,500 por sesión.';
const LASER_OFFER_SECTION = '\n\n# Láser CO₂: evaluación médica y precio especial';

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
  'El pago es en el consultorio el día de la cita: efectivo, tarjeta o transferencia, y con tarjeta siempre hay 3 meses sin intereses. Si pregunta por anticipos, paquetes o membresías, contéstalo desde lo que sí hay — se paga completo ese día y ya.';
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
- Dirección (cuando la pidan): Periférico de la Juventud 6902, Plaza Cumbres, Local 34, Chihuahua, Chih., C.P. 31217. El consultorio es el Local 34, justo enfrente de la tienda de AT&T: esa referencia va SIEMPRE pegada a la dirección, y es también la respuesta cuando alguien ya está en la plaza y no encuentra el consultorio.
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

/**
 * La consulta a $500 parejo y el láser presentado como precio normal → precio especial
 * (prod, 2026-10-06). Cada par es [texto vivo, texto anterior]: el lado rojo restaura el
 * anterior, que es el que le dijo a una lead de lp5 "la consulta de valoración no tiene costo".
 */
const CONSULTA_500_SWAPS: Array<[string, string]> = [
  [
    `- La consulta con el Dr. Valdivia cuesta $500, se paga en el consultorio el día de la cita y se acredita completa al tratamiento que se haga. Para el láser CO₂, esa consulta es la evaluación médica. La consulta de bariatría es otra: $1,500. Dilo cuando pregunten por el costo de la consulta y, en media línea, la primera vez que le ofrezcas horarios, para que llegue sin sorpresas. Si tu campaña trae su propia forma de apartar la consulta, sigue esa.`,
    `- El costo de la consulta de valoración NO se menciona salvo que el lead pregunte explícitamente cuánto cuesta la consulta. PROHIBIDO decir "sin costo", "no tiene costo" o "gratis" de la consulta al explicar el flujo o al dar el precio de un tratamiento, aunque lookupFaq te lo traiga: ese dato existe solo para contestar esa pregunta.
- La evaluación médica de láser CO₂ es distinta: cuesta $500 y es parte de la oferta del láser, así que se dice cada vez que das el precio del láser. De esa evaluación NUNCA digas que es gratis, sin costo o de cortesía.`,
  ],
  [' La consulta cuesta $500 y se acredita completa al tratamiento que se haga.', ''],
  [
    '- Cuando pregunten el precio del láser, preséntalo en este orden, y el $3,500 SIEMPRE con las palabras "precio especial" (dicho como "queda en $3,500" se lee como un número más, y lo que tiene que quedar claro es que es un beneficio): primero el precio normal, $4,500 por sesión; luego el precio especial: si inicia su tratamiento dentro de los 14 días siguientes a su evaluación, le aplicamos $3,500 por sesión en todo su tratamiento; y al final, que su evaluación con el Dr. Valdivia cuesta $500 y se le descuenta de la primera sesión, y que ahí el doctor define cuántas sesiones necesita. Ejemplo del tono (no lo copies literal): "El precio normal del láser es de $4,500 por sesión. Pero si inicias tu tratamiento dentro de los 14 días siguientes a tu evaluación, te aplicamos un precio especial de $3,500 por sesión en todo tu tratamiento 😊 Tu evaluación con el Dr. Valdivia cuesta $500 y se te descuenta de la primera sesión; ahí el doctor define cuántas sesiones necesitas." El resto (qué pasa si inicia después, el plazo de 4 meses, el kit) va por goteo, cuando lo pregunte.',
    '- Cuando pregunten el precio del láser, la respuesta es: la evaluación cuesta $500; las sesiones cuestan $4,500, o $3,500 si inicia en los 14 días siguientes a su evaluación; el número de sesiones lo define el doctor en la evaluación. El resto (cómo se acreditan los $500, el plazo de 4 meses, el kit) va por goteo, cuando lo pregunte.',
  ],
  [
    'La consulta con el Dr. Valdivia cuesta $500, se paga en el consultorio el día de la cita y se acredita completa al tratamiento que se haga. Para el láser CO₂, esa consulta es la evaluación médica. La consulta de bariatría es otra: $1,500, e incluye valoración médica y seguimiento para control de peso.',
    'Solo si el lead pregunta por el costo de la consulta: la consulta de valoración estética no tiene costo, excepto la evaluación médica de láser CO₂, que cuesta $500 y siempre se acredita a su tratamiento. La consulta de bariatría sí tiene costo: $1,500, e incluye valoración médica y seguimiento para control de peso.',
  ],
  ['¿Cuánto cuesta la valoración?', '¿La valoración es gratis?'],
  [
    ' Precio normal: $4,500 por sesión; precio especial: $3,500 por sesión en todo el tratamiento si lo inicia dentro de los 14 días siguientes a su evaluación médica ($500, que se descuenta de la primera sesión).',
    ' $4,500 por sesión, o $3,500 por sesión si asiste a su primera sesión dentro de los 14 días siguientes a su evaluación médica de láser ($500).',
  ],
  [
    'El precio normal del láser es de $4,500 por sesión. Si inicia su tratamiento dentro de los 14 días siguientes a su evaluación, aplica el precio especial de $3,500 por sesión en todo su tratamiento. La evaluación con el Dr. Valdivia cuesta $500 y se descuenta de su primera sesión. El número de sesiones lo define el Dr. Valdivia en la evaluación.',
    'La evaluación médica de láser cuesta $500. Las sesiones cuestan $4,500, o $3,500 si asiste a su primera sesión dentro de los 14 días siguientes a su evaluación. El número de sesiones lo define el Dr. Valdivia en la evaluación.',
  ],
  [
    'Precio normal $4,500 por sesión; precio especial de $3,500 por sesión en todo el tratamiento si lo inicia dentro de los 14 días siguientes a su evaluación médica ($500, que se descuenta de la primera sesión).',
    '$4,500 por sesión, o $3,500 por sesión si inicia dentro de los 14 días siguientes a su evaluación médica de láser ($500).',
  ],
];

/**
 * "El precio es el momento" (prod, 2026-10-09): [texto vivo, texto anterior]. El anterior
 * pedía "la consulta" como siguiente paso y el modelo lo cumplía preguntando "¿te aparto un
 * espacio?" — en octubre 8 de 16 leads calificados de láser preguntaron el precio de la
 * evaluación, recibieron los $500 y esa pregunta, y no volvieron a escribir. El vivo exige
 * getAvailability en ese mismo turno y los dos horarios pegados al precio.
 */
const OLD_PRICE_WORDING: [string, string] = [
  'Cuando des un precio y ya sabes qué le interesa, ese MISMO mensaje lleva el siguiente paso, y el siguiente paso son HORARIOS: llama getAvailability en ese mismo turno y cierra con los DOS horarios concretos para su consulta con el Dr. Valdivia, en una línea, pegados al precio. No preguntes antes si quiere que le apartes un espacio ni si prefiere inicio o final de semana: un precio seguido de una pregunta de permiso deja la conversación muerta justo cuando más interesada está la persona; un precio seguido de dos horarios la convierte en una decisión. Esto adelanta el momento de ofrecer la consulta: si ya sabes qué le interesa, el precio ES ese momento (salvo en tu primer mensaje, que sigue su regla). Aplica igual cuando el precio que pregunta es el de la consulta o la evaluación: los $500 que se acreditan a su tratamiento y, en la misma línea, los dos horarios. Si pregunta un precio directo, dáselo — no lo aplaces ni lo condiciones a preguntas.',
  'Cuando des un precio y ya sabes qué le interesa, ese MISMO mensaje lleva el siguiente paso: el número, amarrado a lo que te contó, y enseguida la consulta con el Dr. Valdivia. Un precio suelto deja la conversación muerta justo cuando más interesada está la persona. Si pregunta un precio directo, dáselo — no lo aplaces ni lo condiciones a preguntas.',
];

const tenantWithout = (
  rule: 'afternoon-only' | 'morning-ask' | 'medical' | 'drip' | 'service-name' | 'next-step' | 'zone-list' | 'slot-contrast' | 'stale-promo' | 'consulta-why' | 'first-time-fear' | 'negative-payments' | 'discovery-first' | 'city-split' | 'lada-faq' | 'zone-vocabulary' | 'walk-in' | 'laser-offer' | 'consulta-500' | 'price-to-slots',
): TenantContext => {
  const p = HERIBERTO_PERSONA;
  const cfg = heribertoTenant.config;
  if (rule === 'price-to-slots') {
    if (!p.qualificationNotes.includes(OLD_PRICE_WORDING[0])) throw new Error('price wording not found');
    return {
      ...heribertoTenant,
      config: {
        ...cfg,
        promptOverrides: { ...p, qualificationNotes: p.qualificationNotes.replace(OLD_PRICE_WORDING[0], OLD_PRICE_WORDING[1]) },
      },
    };
  }
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
  if (rule === 'morning-ask') {
    if (!p.houseRules.includes(OLD_MORNING_WORDING[0])) throw new Error('morning wording not found');
    return {
      ...heribertoTenant,
      config: {
        ...cfg,
        promptOverrides: { ...p, houseRules: p.houseRules.replace(OLD_MORNING_WORDING[0], OLD_MORNING_WORDING[1]) },
      },
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
  if (rule === 'stale-promo') {
    const swap = (text: string): string => {
      let out = text;
      for (const [now, before] of STALE_PROMO_SWAPS) out = out.split(now).join(before);
      return out;
    };
    const offering = swap(p.offering);
    const faq = HERIBERTO_FAQ.map((f) => ({ q: f.q, a: swap(f.a) }));
    const seen = (now: string) => p.offering.includes(now) || HERIBERTO_FAQ.some((f) => f.a.includes(now));
    for (const [now] of STALE_PROMO_SWAPS) if (!seen(now)) throw new Error(`stale-promo anchor not found: ${now.slice(0, 50)}`);
    return { ...heribertoTenant, config: { ...cfg, faq, promptOverrides: { ...p, offering } } };
  }
  if (rule === 'consulta-500') {
    // Red side = the config as it was: free consulta (laser excepted) and the laser price
    // read as "$4,500, o $3,500 si…". Every [new, old] pair must be found, or it throws.
    const swap = (s: string): string => {
      let out = s;
      for (const [now, before] of CONSULTA_500_SWAPS) out = out.split(now).join(before);
      return out;
    };
    const houseRules = swap(p.houseRules);
    const offering = swap(p.offering);
    const faq = HERIBERTO_FAQ.map((f) => ({ q: swap(f.q), a: swap(f.a) }));
    const services = cfg.services ? (cfg.services as Array<Record<string, unknown>>).map((sv) =>
      typeof sv.description === 'string' ? { ...sv, description: swap(sv.description) } : sv) : cfg.services;
    const all = JSON.stringify([houseRules, offering, faq, services]);
    for (const [now] of CONSULTA_500_SWAPS) if (all.includes(now)) throw new Error(`consulta-500 swap left: ${now.slice(0, 40)}`);
    if (JSON.stringify([houseRules, offering, faq, services]) === JSON.stringify([p.houseRules, p.offering, HERIBERTO_FAQ, cfg.services]))
      throw new Error('consulta-500: nothing swapped');
    return { ...heribertoTenant, config: { ...cfg, faq, services, promptOverrides: { ...p, houseRules, offering } } };
  }
  if (rule === 'laser-offer') {
    // The offer lives in three places, and all three go: the list line, the offering section
    // and every FAQ answer that carries the $3,500. What's left is the list price alone.
    const start = p.offering.indexOf(LASER_OFFER_SECTION);
    if (start < 0) throw new Error('laser offer section not found');
    const offering = p.offering.slice(0, start).replace(LASER_OFFER_LINE, LASER_LIST_PRICE_LINE);
    if (!offering.includes(LASER_LIST_PRICE_LINE)) throw new Error('laser offer line not found');
    const faq = HERIBERTO_FAQ.filter((f) => !/3,500|3,000/.test(f.a));
    if (faq.length === HERIBERTO_FAQ.length) throw new Error('laser offer FAQ entries not found');
    return { ...heribertoTenant, config: { ...cfg, faq, promptOverrides: { ...p, offering } } };
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

  // El precio es el momento (2026-10-09). Historia tomada de los hilos de lp5 de octubre: la lead
  // ya dijo qué le preocupa (marcas hundidas en mejillas) y pregunta el costo de la valoración.
  // Con el texto anterior el bot contestaba "$500… ¿te aparto un espacio?" y 8 de 16 leads
  // calificados no volvieron a escribir. El texto vivo exige los dos horarios en ese turno.
  // Medición: ver la cabecera del archivo (HERIBERTO_RULE_OFF=1 restaura el texto anterior).
  it('lead asks the consult price after saying her case → price AND two real slots, same turn', async () => {
    const res = await buildFrontDeskAgent().generate(
      [
        { role: 'user', content: 'Hola, tengo cicatrices de acné y quiero saber cuánto pueden mejorar' },
        {
          role: 'assistant',
          content:
            '¡Hola! Gracias por escribir, soy Sofía, del consultorio del Dr. Valdivia 😊 Las cicatrices de acné sí se pueden mejorar, y cuánto depende del tipo de cicatriz. ¿Son marcas hundidas, manchas oscuras o las dos?',
        },
        { role: 'user', content: 'Marcas hundidas, en las mejillas' },
        {
          role: 'assistant',
          content:
            'Gracias, en las mejillas. Las marcas hundidas se revisan en consulta para que el Dr. Valdivia valore el tipo de cicatriz y te diga cuánto pueden mejorar. ¿Te gustaría apartar tu evaluación?',
        },
        { role: 'user', content: '¿Qué costo tiene la valoración?' },
      ],
      { requestContext: rc(tenantFor('price-to-slots')) },
    );
    expect(toolIds(res)).toContain('getAvailability');
    expect(reply(res)).toMatch(/\$\s?500\b/);
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
 * La promo de septiembre de bótox y Sculptra se quedó en la config hasta el 2026-10-08, y en
 * octubre el modelo la seguía citando (o decía "la promoción de septiembre ya terminó"). Hoy
 * la única promoción es el precio especial del láser: los demás tratamientos van a su precio
 * de lista, sin comparación ni fecha. Maseteros es la guardia de que no se invente un "regular".
 */
describe.skipIf(!evalApiKey)('Dr. Heriberto Valdivia — precios sin promo vencida', () => {
  const STALE = /2[,.]?125|12[,.]?499|septiembre/;

  it('precio de frente → $2,500, sin promoción de septiembre', async () => {
    const res = await buildFrontDeskAgent().generate(
      [
        { role: 'user', content: 'Hola, me interesa el botox' },
        { role: 'assistant', content: OPENER },
        { role: 'user', content: '¿Cuánto sale el de la frente?' },
      ],
      { requestContext: rc(tenantFor('stale-promo')) },
    );
    const text = reply(res);
    expect(text, text).toMatch(/\$\s?2[,.]?500\b/);
    expect(text, text).not.toMatch(STALE);
  }, 120_000);

  it('Sculptra → $18,000 por vial, sin promoción de septiembre', async () => {
    const res = await buildFrontDeskAgent().generate(
      [
        { role: 'user', content: 'Hola, me interesa Sculptra' },
        { role: 'assistant', content: OPENER },
        { role: 'user', content: '¿Cuánto cuesta?' },
      ],
      { requestContext: rc(tenantFor('stale-promo')) },
    );
    const text = reply(res);
    expect(text, text).toMatch(/\$\s?18[,.]?000\b/);
    expect(text, text).not.toMatch(STALE);
  }, 120_000);

  it('"¿tienen promociones?" → el precio especial del láser, nada de bótox en promoción', async () => {
    const res = await buildFrontDeskAgent().generate(
      [
        { role: 'user', content: 'Hola, me interesa el botox' },
        { role: 'assistant', content: OPENER },
        { role: 'user', content: '¿Tienen alguna promoción?' },
      ],
      { requestContext: rc(tenantFor('stale-promo')) },
    );
    const text = reply(res);
    expect(text, text).toMatch(/l[aá]ser/);
    expect(text, text).not.toMatch(STALE);
    // Answered from the price list — not parked as a pending question for the team.
    expect(text, text).not.toMatch(/confirm(ar|o)|consult(ar|o) con el equipo/);
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
    expect(text, text).not.toMatch(/regular\s*\$?\s?(?!3[,.]?500)\d/);
  }, 120_000);
});

/**
 * El láser tiene un precio normal y uno especial, y el especial depende de una evaluación
 * de $500: los tres números van juntos cuando preguntan el precio, sin importar de qué
 * anuncio venga la persona (prod, 2026-10-05).
 */
describe.skipIf(!evalApiKey)('Dr. Heriberto Valdivia — oferta del láser', () => {
  it('precio de sesión → $4,500, $3,500 a 14 días y evaluación de $500', async () => {
    const res = await buildFrontDeskAgent().generate(
      [
        { role: 'user', content: 'Hola, me interesa el láser CO2' },
        { role: 'assistant', content: OPENER },
        { role: 'user', content: '¿Cuánto cuesta una sesión?' },
      ],
      { requestContext: rc(tenantFor('laser-offer')) },
    );
    const text = reply(res);
    expect(text, text).toMatch(/\$\s?4[,.]?500\b/);
    expect(text, text).toMatch(/\$\s?3[,.]?500\b/);
    expect(text, text).toMatch(/14 d[ií]as/);
    expect(text, text).toMatch(/\$\s?500\b/);
    expect(text, text).not.toMatch(/gratis|sin costo|cortes[ií]a/);
  }, 120_000);
});

/**
 * La consulta cuesta $500 parejo y el láser se presenta como precio normal → precio especial
 * (prod, 2026-10-06). El hilo real (lp5, Facebook): una lead de cicatrices de acné preguntó
 * "Dónde se ubica" y "Y el costo", y el bot copió la entrada de FAQ que decía que la consulta
 * no tenía costo salvo la del láser: "La consulta de valoración estética no tiene costo. Si el
 * doctor considera láser CO₂, la evaluación médica cuesta $500; las sesiones son de $4,500, o
 * $3,500 si…". Dos fallas: una consulta gratis que no existe para ella, y un precio que se lee
 * como dos números sueltos en vez de un precio especial.
 */
const NO_FREE = /sin costo|no tiene costo|gratis|gratuita|cortes[ií]a|sin cargo/;
const normalBeforeSpecial = (text: string): boolean => {
  const normal = text.search(/\$\s?4[,.]?500\b/);
  const special = text.search(/\$\s?3[,.]?500\b/);
  return normal >= 0 && special > normal;
};

describe.skipIf(!evalApiKey)('Dr. Heriberto Valdivia — consulta a $500 y el láser como precio especial', () => {
  it('hilo de lp5: "Dónde se ubica" + "Y el costo" → precio normal, luego especial; nada gratis', async () => {
    const res = await buildFrontDeskAgent().generate(
      [
        { role: 'user', content: 'Hola, tengo cicatrices de acné y quiero saber cuánto pueden mejorar' },
        {
          role: 'assistant',
          content:
            '¡Hola! Soy Sofía, del consultorio del Dr. Heriberto Valdivia 😊 Las cicatrices de acné sí se pueden mejorar, y cuánto depende del tipo de cicatriz. ¿Son marcas hundidas, manchas oscuras o las dos?',
        },
        { role: 'user', content: 'Dónde se ubica' },
        { role: 'user', content: 'Y el costo' },
      ],
      { requestContext: rc(tenantFor('consulta-500')) },
    );
    const text = reply(res);
    expect(text, text).not.toMatch(NO_FREE);
    expect(normalBeforeSpecial(text), text).toBe(true);
    expect(text, text).toMatch(/especial/);
    expect(text, text).toMatch(/\$\s?500\b/);
  }, 120_000);

  it('"¿la consulta tiene costo?" → $500 que se acreditan; nada gratis', async () => {
    const res = await buildFrontDeskAgent().generate(
      [
        { role: 'user', content: 'Hola, me interesa el botox' },
        { role: 'assistant', content: OPENER },
        { role: 'user', content: 'Botox para la frente. ¿La consulta tiene costo?' },
      ],
      { requestContext: rc(tenantFor('consulta-500')) },
    );
    const text = reply(res);
    expect(text, text).not.toMatch(NO_FREE);
    expect(text, text).toMatch(/\$\s?500\b/);
    expect(text, text).toMatch(/acredit|descuent|abona/);
    expect(toolIds(res)).not.toContain('flagPendingInfo');
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
   * Si ella pide la mañana, eso ES la excepción: ofrecerle preguntarle al doctor en ese
   * mismo turno, sin explicarle que solo se agenda por la tarde ni volverle a ofrecer las
   * tardes. El primer caso es el mensaje de prod tal cual (2026-09-30, PLAN, Messenger): el
   * bot contestó "por ahora el consultorio agenda únicamente por la tarde" + las mismas
   * tardes, y la excepción llegó un turno después, cuando ella ya se estaba despidiendo.
   */
  const SOLO_TARDE = /(únicamente|solamente|solo|sólo)[^.?!]{0,30}tarde/i;
  const AFTERNOON_SLOT = /\d{1,2}:\d{2}\s*(p\.?\s*m|de la tarde)/i;

  it.each([
    ['la pregunta de prod', 'No tiene horario en la mañana 👋🏽'],
    ['la prefiere', '¿Y en la mañana no hay? Me queda mejor'],
  ])('pide la mañana (%s) → ofrece preguntarle al doctor, sin insistir con la tarde', async (_label, ask) => {
    const res = await buildFrontDeskAgent().generate(
      [...AFTERNOON_THREAD, { role: 'user', content: ask }],
      { requestContext: rc(tenantFor('morning-ask')) },
    );
    const text = reply(res);
    expect(text, text).toMatch(/pregunt|consult|chec|revis|ver con/);
    expect(text, text).toMatch(/doctor|dr\.|valdivia/i);
    expect(text, text).not.toMatch(SOLO_TARDE);
    expect(text, text).not.toMatch(AFTERNOON_SLOT);
    expect(text, text).not.toMatch(/te (aparto|agendo|dejo|guardo) .{0,30}ma(ñ|n)ana/);
    // Todavía no sabe qué mañanas le acomodan: pregunta, así que no marca ni agenda.
    expect(toolIds(res), text).not.toContain('flagAwaitingHuman');
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
