/**
 * The three messages the paid-confirmation flow sends OUTSIDE a turn (0062):
 * deterministic, LLM-free, like the demo reminders — they fire from a webhook
 * or a cron where there is no lead message to answer and no reason to spend a
 * model call on a sentence that must say exactly one thing.
 *
 * `label` is the cita's time as `slotLabel` renders it (already in the lead's
 * clock); `businessName` keeps the message anchored to the client, not to us.
 */

/** A slot label ends in "p.m." — a sentence after it must not add a second period. */
const sentence = (label: string): string => (label.endsWith('.') ? label : `${label}.`);

export function buildHoldPaidMessage(label: string, businessName: string): string {
  return (
    `¡Muchas gracias, ya recibimos tu pago! 🎉 Con eso tu cita en ${businessName} quedó confirmada para el ${sentence(label)} ` +
    'Si algo se te atraviesa, escríbeme con confianza y con gusto la movemos a otro horario. ¡Nos vemos!'
  );
}

export function buildHoldExpiredMessage(label: string): string {
  return (
    `Hola, una disculpa por escribirte: se venció el plazo para apartar tu cita del ${label} y el lugar se liberó. ` +
    'Si todavía la quieres, no te preocupes, mándame un mensaje y con gusto te agendo de nuevo con los horarios que haya.'
  );
}

export function buildHoldPaidLateMessage(businessName: string): string {
  return (
    `¡Gracias, ya recibimos tu pago! Una disculpa: como llegó después del plazo, ese lugar ya se había liberado. ` +
    `Alguien de ${businessName} te escribe en un ratito para acomodarte en otro horario o, si lo prefieres, ver lo de tu pago.`
  );
}
