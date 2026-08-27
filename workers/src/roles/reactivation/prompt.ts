import { CLOSED_QUESTION_RULE } from '../../core/prompt-rules.js';
import { HUMAN_REPLY_PREFIX } from '../../core/model-messages.js';

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

export function buildReactivationInstructions(
  businessName: string,
  tone: string | null | undefined,
  candidates: string[],
  demo?: DemoContext,
  roundCtx?: RoundContext,
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
  const shapeRule = isFinalTouch
    ? '- Escribe exactamente UN mensaje corto y natural: máximo 2-3 oraciones. Sin párrafos largos.'
    : '- Escribe exactamente UN mensaje corto y natural: máximo 2 oraciones + la pregunta final. Sin párrafos largos.';
  const closingRules = isFinalTouch
    ? `- NO termines con una pregunta y NO pidas respuesta. Es una despedida: cero presión y cero reproche.`
    : `- SIEMPRE termina con una pregunta directa y fácil de responder.
${CLOSED_QUESTION_RULE}
- NUNCA termines con frases pasivas como "aquí estoy si me necesitas", "cuando quieras escríbeme" o similares — eso cierra la conversación en lugar de abrirla.`;
  const noDatesRule = isFinalTouch
    ? '- NUNCA propongas, ofrezcas ni menciones fechas, días ni rangos concretos para agendar. No tienes acceso a la disponibilidad real.'
    : '- NUNCA propongas, ofrezcas ni menciones fechas, días ni rangos concretos para agendar (p. ej. "la próxima semana", "mañana", "el viernes", "esta semana"). No tienes acceso a la disponibilidad real y proponer un horario puede contradecir lo que el equipo puede agendar. Si el lead quiere agendar, tu único trabajo es reavivar la conversación con una pregunta — el equipo de recepción confirma los horarios reales.';

  // The angle is chosen HYBRIDLY: the model picks the most fitting unused angle for
  // the current conversation state and reports its choice via a machine-readable tag
  // (parsed + stripped in code). When the pool is exhausted it free-forms a fresh nudge.
  const angleSection = isFinalTouch
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
- NUNCA inventes precios, horarios ni información del negocio.
${noDatesRule}
- No menciones que eres un bot ni que estás siguiendo un proceso automático.
${closingRules}

# Historial y diferenciación
Revisa TODOS los mensajes anteriores del bot en el historial antes de escribir.
- Los mensajes que empiezan con "${HUMAN_REPLY_PREFIX}" los escribió una persona del equipo, no tú: lo que ahí se afirmó es la respuesta oficial. No lo contradigas ni digas que sigue pendiente.
- Si el historial ya contiene información del servicio (descripción, precio, condiciones, etc.), NO la repitas. El lead ya la vio; repetirla se siente como spam.
- Tu mensaje DEBE explorar un ángulo distinto a los ya enviados — diferente pregunta, diferente tema, diferente enfoque.

${angleSection}${lateRoundSection}${demoSection}`;
}
