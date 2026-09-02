/**
 * Wording rules shared by every role's prompt.
 *
 * A rule lives here (and not inside a role) when it is about HOW the bot writes
 * rather than what it does — so front-desk and reactivation can't drift apart on
 * it, and a single unit test gates both.
 */

/**
 * Closed questions, yes — but never the literal label.
 *
 * The failure this closes (production, 2026-08-11): a reactivation nudge went out as
 * "¿quieres que te ayudemos a agendar cita, si o no?". Two instructions pushed it
 * there and both were meant as SHAPE, not as text to copy: the reactivation prompt
 * asked for a question "fácil de responder con una sola palabra o sí/no", and several
 * tenant angles literally read "Pregunta de sí o no". The model rendered the spec.
 *
 * To a lead that reads as an interrogation with a deadline, and the cost is silent:
 * she doesn't complain, she just stops answering — the one outcome a follow-up exists
 * to prevent. So the ban is on the WORDS, stated next to the intent it protects,
 * because the model has to be able to tell them apart.
 */
export const CLOSED_QUESTION_RULE = `- Tus preguntas se contestan con UNA palabra o eligiendo entre dos opciones, pero NUNCA escribas la etiqueta: PROHIBIDO escribir "¿sí o no?", "sí/no", "sí o no", "¿verdad que sí?" o cualquier variante que le ponga al lead las palabras "sí" y "no" como menú. Se lee agresivo y a interrogatorio, y es la forma más rápida de que deje de contestarte.
- Si una instrucción o un ángulo dice "pregunta de sí o no", describe la FORMA de la pregunta, no un texto que debas copiar.
  Mal: "¿Quieres que te ayudemos a agendar tu cita, sí o no?"
  Bien: "¿Te aparto un espacio?"`;

/**
 * Never a bare "no".
 *
 * The failure this closes (Dr. Valdivia's test thread, 2026-09-02): the lead asked for
 * a same-day slot and the bot opened with "Hoy ya no se agenda; el horario más próximo…".
 * Correct, and cold — the tool note and the prompt line had both been written as bans
 * ("no se agenda para hoy"), and the model rendered the ban. Leo: "estamos en México,
 * necesitamos un lenguaje más cálido… eso aplica en todo el lenguaje".
 *
 * So the rule is about the SHAPE of every refusal, in every role: lead with what IS
 * possible, then the next step. The ban words are listed because the model has to be
 * able to tell the intent from the text — same reason CLOSED_QUESTION_RULE lists its.
 */
export const WARM_NO_RULE = `- Nunca un "no" seco. Cuando algo no se puede (para hoy ya no hay espacio, esa fecha no está disponible, ese dato no lo tienes), dilo con calidez y EN POSITIVO: primero lo que sí hay o lo que sí puedes hacer, y enseguida el siguiente paso. PROHIBIDO abrir un mensaje con "No se agenda", "No se puede", "No hay", "No es posible" o un "No" a secas.
  Mal: "Hoy ya no se agenda; el horario más próximo es el viernes."
  Bien: "Para hoy ya no me queda espacio, pero mañana sí: ¿te acomoda más por la mañana o por la tarde?"`;
