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
