import { CLOSED_QUESTION_RULE, VOICE_RULE, WARM_NO_RULE } from '../../core/prompt-rules.js';
import { CAMPAIGN_MESSAGE_PREFIX, HUMAN_REPLY_PREFIX } from '../../core/model-messages.js';
import { STAGE_LABELS } from '../../core/followup-playbook.js';
import type { StageContext } from '../../core/runtime-context.js';

export interface DemoContext {
  businessName?: string;
  booked?: boolean;
}

/** Which reactivation round this nudge belongs to (0049). Absent/round 0 = the
 *  classic prompt, byte-identical. Round 1+ softens the tone; the final touch of
 *  the final round is a farewell that closes the thread instead of baiting a reply. */
export interface RoundContext {
  round: number;
  isFinalTouch: boolean;
  /** The word the farewell teaches ("escribe CITA para retomar"). */
  reentryKeyword: string;
}

/** Hard cap on a nudge's length (prompt-level; the model honours a number far better
 *  than "corto"). ~One WhatsApp line and a question. */
export const NUDGE_MAX_CHARS = 160;

/**
 * How a nudge opens. VOICE_RULE's "react to what the person just said" is right for a
 * live reply and wrong here: nobody said anything — the lead has been silent for hours,
 * and reacting to yesterday's message ("Qué bueno que me cuentas…") is exactly what
 * reads as a script. So the nudge enters directly, and the literal openers the thread
 * already carries are listed as banned (core/nudge-openers.ts): a principle the model
 * ignored for weeks; a list it respects.
 */
export const NUDGE_OPENING_RULE = `# Cómo arranca un seguimiento
Este mensaje NO es una respuesta: la persona lleva horas sin escribir. No reacciones a nada que dijo antes, no celebres que escribió, no saludes con fórmula. Entra directo a lo que vienes a decir o a preguntar, como quien retoma un chat con alguien de confianza.
- Si sabes su nombre por el historial, puedes abrir con él de vez en cuando ("Ana, ¿…?"); no en todos.
- Nunca empieces con "Qué bueno que", "Qué gusto", "Hola, qué gusto", "Espero que", "Solo para", "Te escribo para", "Quería saber si".`;

function bannedOpeners(used: readonly string[]): string {
  if (used.length === 0) return '';
  return `\n- PROHIBIDO empezar con cualquiera de estos arranques, que ya se usaron en esta conversación: ${used.map((o) => `"${o}"`).join(', ')}. Empieza con otras palabras.`;
}

export function buildReactivationInstructions(
  businessName: string,
  tone: string | null | undefined,
  candidates: string[],
  demo?: DemoContext,
  roundCtx?: RoundContext,
  stageCtx?: StageContext,
  usedOpeners: readonly string[] = [],
): string {
  const toneDesc = tone?.trim() || 'cálido, natural y cercano';
  const hasCandidates = candidates.length > 0;
  const isFinalTouch = roundCtx?.isFinalTouch === true;
  const isLateRound = !isFinalTouch && (roundCtx?.round ?? 0) >= 1;

  // Post-demo nudges are a different conversation than the roleplay that precedes them.
  // Without this the runner (which is persona-blind) writes the nudge from the demo
  // transcript and chases the lead about the FAKE appointment they made while pretending
  // to be their own customer — e.g. "¿sigues interesada en tu cita de Botox?".
  const demoSection = demo
    ? `\n\n# CONTEXTO CRÍTICO: este lead acaba de probar una demo
Antes en el historial vas a ver una conversación donde este lead escribía como si fuera CLIENTE de su propio negocio${demo.businessName ? ` ("${demo.businessName}")` : ''}. Eso era una DEMO del producto: un juego de rol, no una conversación real.
- El lead es un DUEÑO DE NEGOCIO evaluando contratarnos, NO un cliente de ese negocio.
- ${demo.booked ? 'La cita que aparece agendada en ese historial fue SIMULADA, parte de la demo. NO existe.' : 'Nada de lo que se habló ahí (servicios, precios, tratamientos) es real para esta conversación.'}
- PROHIBIDO ABSOLUTAMENTE: preguntarle por esa cita, por esos tratamientos o por cualquier servicio del negocio DEL LEAD. Sería absurdo — nosotros no se los damos.
- Tu mensaje retoma UNA sola cosa: si le interesa tener este asistente en su negocio y dar el siguiente paso con nuestro equipo. Puedes apoyarte en que ya vio la demo funcionando.`
    : '';

  // A lead on round 1+ already ignored a full cycle: pushing harder only burns
  // goodwill, so the late rounds dial the pressure down and offer an easy out.
  const lateRoundSection = isLateRound
    ? `\n\n# CONTEXTO: reintento tardío (ronda ${roundCtx!.round + 1})
Este lead ya dejó pasar una ronda completa de seguimientos sin responder.
- Baja la intensidad: tono suave y de cero presión. Nada de urgencia ni de insistir.
- Reconoce con ligereza que quizá no es buen momento, sin que suene a reproche.
- Ofrécele una salida fácil: que con decir "no por ahora" dejamos de escribirle.`
    : '';

  // The farewell is the ONE nudge whose job is to close, not to bait a reply —
  // so the question-mandate rules and the angle machinery are swapped out, not
  // contradicted. The angle pool is bypassed by the runner (candidates = []).
  // The nudge's shape (2026-10-12). Before: "máximo 2 oraciones + la pregunta" — and the
  // model wrote exactly that, every time: reaction + fact + question, 130–170 chars,
  // a semicolon in the middle. 851 nudges with the same silhouette read as a program.
  // A person following up on WhatsApp writes "¿Pudiste ver lo del láser?" and stops.
  const shapeRule = (isFinalTouch
    ? '- Escribe exactamente UN mensaje corto y natural: máximo 2-3 oraciones. Sin párrafos largos.'
    : `- Escribe exactamente UN mensaje, de ${NUDGE_MAX_CHARS} caracteres como máximo. Una sola idea: o SOLO la pregunta, o una frase corta y la pregunta. Nunca dos datos, nunca punto y coma para encadenar.`) +
    `\n${WARM_NO_RULE}\n\n${VOICE_RULE}${isFinalTouch ? '' : `\n\n${NUDGE_OPENING_RULE}${bannedOpeners(usedOpeners)}`}`;
  const closingRules = isFinalTouch
    ? `- NO termines con una pregunta y NO pidas respuesta. Es una despedida: cero presión y cero reproche.`
    : `- SIEMPRE termina con una pregunta directa y fácil de responder.
${CLOSED_QUESTION_RULE}
- NUNCA termines con frases pasivas como "aquí estoy si me necesitas", "cuando quieras escríbeme" o similares — eso cierra la conversación en lugar de abrirla.`;
  const noDatesRule = isFinalTouch
    ? '- NUNCA propongas, ofrezcas ni menciones fechas, días ni rangos concretos para agendar. No tienes acceso a la disponibilidad real.'
    : `- NUNCA propongas, ofrezcas ni menciones fechas, días ni rangos concretos para agendar (p. ej. "la próxima semana", "mañana", "el viernes", "esta semana"). No tienes acceso a la disponibilidad real y proponer un horario puede contradecir lo que el equipo puede agendar. Si el lead quiere agendar, tu único trabajo es reavivar la conversación con una pregunta — el equipo de recepción confirma los horarios reales.
- PERO si el ÚLTIMO mensaje del bot en el historial ya le ofreció horarios concretos y el lead no contestó, no arranques de cero: lo único que falta es que elija. Esta regla manda sobre los ángulos de abajo — preguntarle otra vez si quiere que le aparten un espacio la regresa un paso, porque eso ya lo dijo.
  Retoma esa elección SIN repetir el día ni la hora (pudieron ocuparse desde entonces): alude a los horarios que ya le pasaste y pregúntale si alguno le sirve o si le buscas otro. Esa alusión es la ÚNICA forma en que puedes tocar el tema de horarios; sigue prohibido repetirlos, confirmarlos o proponer uno nuevo.`;

  // The stage (0068): where the lead stopped and what THIS nudge is for. The service
  // block is the one place the nudge may take facts from — the agent has no tools and
  // the pre-0068 prompt forbade stating any business fact at all, which is right for a
  // lead who already heard them and wrong for one who never got past the ad's opener.
  // Off (no playbook) = this section is absent and the prompt is byte-identical.
  const stageSection = stageCtx && !isFinalTouch
    ? `\n\n# Etapa del lead: ${stageCtx.stage} — ${STAGE_LABELS[stageCtx.stage]}
Objetivo de ESTE mensaje: ${stageCtx.objective}
Esta etapa manda sobre los ángulos: si un ángulo pide algo que el objetivo prohíbe (p. ej. pedir cita a un lead NI), adapta el ángulo al objetivo.${stageCtx.service
      ? `\n\n# Lo que le interesa
Tratamiento: ${stageCtx.service.name}.${stageCtx.service.description ? `\nLo ÚNICO que puedes afirmar sobre él (datos de la clínica, cítalos tal cual, sin redondear ni completar): ${stageCtx.service.description}` : '\nNo hay datos del tratamiento en la config: no afirmes nada sobre él.'}
Si el historial ya le dio uno de estos datos, usa OTRO; nunca repitas el mismo.`
      : ''}`
    : '';

  // The angle is chosen HYBRIDLY: the model picks the most fitting unused angle for
  // the current conversation state and reports its choice via a machine-readable tag
  // (parsed + stripped in code). When the pool is exhausted it free-forms a fresh nudge.
  // Sequence mode (0070) replaces the pick: the runner already chose the step and the
  // model only writes it — no tag, no list.
  const stepSection = stageCtx?.step && !isFinalTouch
    ? `# Este mensaje
${stageCtx.step}

# Formato de salida
Escribe ÚNICAMENTE el mensaje para el lead.`
    : null;
  const angleSection = stepSection !== null
    ? stepSection
    : isFinalTouch
    ? `# Mensaje FINAL de despedida
Este es el ÚLTIMO seguimiento que este lead va a recibir. Tu trabajo es cerrar con calidez, no reabrir la conversación.
- Despídete breve y amable: entendemos que no es el momento y dejamos de escribirle para no molestar.
- Deja la puerta abierta: dile que si más adelante quiere retomar o agendar, basta con escribir "${roundCtx!.reentryKeyword}" por este mismo chat.

# Formato de salida
Escribe ÚNICAMENTE el mensaje para el lead.`
    : hasCandidates
      ? `# Ángulos disponibles (elige UNO)
Elige el ángulo que mejor encaje con el estado actual de la conversación — el que más avance la relación dado lo que el lead ya dijo. NO elijas un ángulo cuyo tema ya se haya cubierto en el historial.
${candidates.map((c, i) => `${i + 1}. ${c}`).join('\n')}

# Formato de salida (OBLIGATORIO)
En la PRIMERA línea escribe EXACTAMENTE "ANGULO: n", donde n es el número del ángulo que elegiste. A partir de la segunda línea escribe ÚNICAMENTE el mensaje para el lead — sin explicar tu elección.`
      : `# Sin ángulos predefinidos
Ya se usaron todos los ángulos disponibles. Escribe un mensaje fresco y genuinamente distinto a todo lo que ya se envió en el historial, para retomar contacto sin repetir ningún tema anterior.

# Formato de salida
Escribe ÚNICAMENTE el mensaje para el lead.`;

  return `Eres el asistente de "${businessName}". Tu único objetivo es enviar UN mensaje corto para retomar contacto con un lead que dejó de responder.

# Instrucciones
${shapeRule}
- Tono: ${toneDesc}.
- NUNCA uses markdown, listas, negritas ni links.
- NUNCA inventes precios, horarios ni información del negocio.${stageCtx ? ' Los únicos datos del negocio que puedes citar son los de "Lo que le interesa".' : ''}
${noDatesRule}
- No menciones que eres un bot ni que estás siguiendo un proceso automático.
${closingRules}

# Historial y diferenciación
Revisa TODOS los mensajes anteriores del bot en el historial antes de escribir.
- Los mensajes que empiezan con "${HUMAN_REPLY_PREFIX}" los escribió una persona del equipo, no tú: lo que ahí se afirmó es la respuesta oficial. No lo contradigas ni digas que sigue pendiente.
- Un mensaje que empieza con "${CAMPAIGN_MESSAGE_PREFIX}" es una plantilla que el equipo mandó a varias personas: lo que ofrece es la oferta vigente, y lo que el hilo decía antes de él ya no aplica.
- Si el historial ya contiene información del servicio (descripción, precio, condiciones, etc.), NO la repitas. El lead ya la vio; repetirla se siente como spam.
- Tu mensaje DEBE explorar un ángulo distinto a los ya enviados — diferente pregunta, diferente tema, diferente enfoque.

${angleSection}${stageSection}${lateRoundSection}${demoSection}`;
}
