/**
 * The one human label for an appointment time. Every tool that hands the model a
 * time (availability, booking, lookup, reschedule) and the prompt's own
 * "ya tiene cita" line go through here, so a lead reads the same shape everywhere:
 *
 *   jueves 4 de septiembre, 3:00 p.m. hora de Ciudad de México
 *
 * `frameTz` is the clock the LEAD reads (core/lead-timezone.ts); the suffix only
 * appears when that clock differs from the business's at that instant. The model
 * is told to repeat the label verbatim, so the suffix is what stops "las 3" from
 * meaning two different hours.
 */

import { zoneSuffix } from '../../../core/lead-timezone.js';

export function slotLabel(iso: string, frameTz: string, tenantTz: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  try {
    const base = new Intl.DateTimeFormat('es-MX', {
      timeZone: frameTz,
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    }).format(at);
    return base + zoneSuffix(frameTz, tenantTz, at);
  } catch {
    return iso;
  }
}
