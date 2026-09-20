/**
 * The three messages the paid-confirmation flow sends OUTSIDE a turn (0062):
 * deterministic, LLM-free, like the demo reminders — they fire from a webhook
 * or a cron where there is no lead message to answer and no reason to spend a
 * model call on a sentence that must say exactly one thing.
 *
 * `label` is the cita's time as `slotLabel` renders it (already in the lead's
 * clock); `businessName` keeps the message anchored to the client, not to us.
 */

export function buildHoldPaidMessage(label: string, businessName: string): string {
  return `¡Listo, recibimos tu pago! 🎉 Tu cita en ${businessName} quedó confirmada para el ${label}. Si algo cambia, escríbeme y la movemos a otro horario. Ahí nos vemos.`;
}

export function buildHoldExpiredMessage(label: string): string {
  return (
    `Se venció el plazo para apartar tu cita del ${label} y el lugar se liberó. ` +
    'Si todavía la quieres, escríbeme y te agendo de nuevo con los horarios que haya disponibles.'
  );
}

export function buildHoldPaidLateMessage(businessName: string): string {
  return (
    `Recibimos tu pago, gracias. Como llegó después del plazo, el lugar ya se había liberado; ` +
    `una persona de ${businessName} te escribe en breve para acomodarte o devolverte el pago.`
  );
}
