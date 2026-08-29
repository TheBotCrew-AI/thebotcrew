/**
 * One rule for turning "the name the lead gave" into GHL's firstName/lastName —
 * shared by the updateContactName tool, the booking-time write in bookAppointment,
 * and the opening-turn backstop in the webhook handler, so a contact never ends up
 * split three different ways.
 *
 * First word → firstName, the rest → lastName. Compound first names ("María José")
 * land half in the surname; GHL shows the full name either way, and guessing which
 * words are given names is worse than a predictable split.
 */
export function splitContactName(name: string | null | undefined): { firstName: string; lastName: string } | null {
  const trimmed = (name ?? '').trim().replace(/\s+/g, ' ');
  if (!trimmed) return null;
  const [firstName, ...rest] = trimmed.split(' ');
  return { firstName: firstName!, lastName: rest.join(' ') };
}
