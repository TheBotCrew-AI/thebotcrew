/**
 * appointment-title — builds the calendar event title staff see in GHL.
 *
 * "Karla Mendoza — Bótox frente y entrecejo — Jornada Bótox"
 *
 * Every part is optional except the fallback service name, so the title degrades
 * gracefully: no name → starts at the treatment; no treatment discussed → the
 * service name (the pre-existing behavior, "Consulta"); no campaign label → no
 * suffix. The campaign label comes from the pinned prompt variant's
 * `calendarLabel` (config), never from the model — the model only contributes
 * the treatment wording, which is display-only.
 */

export interface AppointmentTitleParts {
  /** Name the lead gave (tool param), falling back to the CRM contact name. */
  contactName?: string | null;
  /** Treatment as discussed in the conversation (model-provided, display-only). */
  treatment?: string | null;
  /** The booked service — the fallback when no treatment was discussed. */
  serviceName: string;
  /** Campaign label from the pinned variant's `calendarLabel` (e.g. "Jornada Bótox"). */
  campaignLabel?: string | null;
}

export function buildAppointmentTitle(parts: AppointmentTitleParts): string {
  const what = parts.treatment?.trim() || parts.serviceName;
  return [parts.contactName?.trim() || null, what, parts.campaignLabel?.trim() || null]
    .filter((p): p is string => !!p)
    .join(' — ');
}
