/**
 * Waitlist task — the dated reminder behind "te anoto en la lista de espera".
 *
 * A lead who can't book inside the horizon names the date they want. The tag
 * (`awaiting_human_tag`) records the STATE; this builds the GHL task that tells a
 * person WHEN to act: the task falls due the day that date enters the booking
 * window (date − horizon days, in the tenant's clock), never before today.
 *
 * Pure: the tool calls `GhlClient.createContactTask` with what this returns.
 */

import { slotWallKey, zonedWallClockToMs } from './booking-time.js';

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

export interface WaitlistTask {
  title: string;
  body: string;
  /** ISO instant — 09:00 local on the due day. */
  dueDate: string;
  /** The due day as YYYY-MM-DD, for the event log. */
  dueDay: string;
}

const wallKey = (ms: number, timeZone: string): string | null => {
  const key = slotWallKey(new Date(ms).toISOString(), timeZone);
  const m = key ? /^(\d{4}-\d{2}-\d{2})T/.exec(key) : null;
  return m ? m[1]! : null;
};

/**
 * `waitlistDate` is the day the lead asked for (YYYY-MM-DD). Returns null when it is
 * not a date — the model is told to send one, but a free-text "la semana que entra"
 * must not become a task due on an invented day.
 */
export function buildWaitlistTask(
  waitlistDate: string,
  opts: { horizonDays: number | null | undefined; nowMs: number; timeZone: string; summary?: string | null; businessName: string },
): WaitlistTask | null {
  const m = ISO_DAY.exec(waitlistDate.trim());
  if (!m) return null;
  const [y, mo, d] = [+m[1]!, +m[2]!, +m[3]!];
  const requestedMs = zonedWallClockToMs(y, mo, d, 9, 0, opts.timeZone);
  if (!Number.isFinite(requestedMs)) return null;

  const horizon = opts.horizonDays ?? 0;
  let dueMs = zonedWallClockToMs(y, mo, d - horizon, 9, 0, opts.timeZone);
  // Already inside the window (or the date passed): act today, never in the past.
  const today = wallKey(opts.nowMs, opts.timeZone);
  const dueKey = wallKey(dueMs, opts.timeZone);
  if (today && dueKey && dueKey < today) {
    const t = /^(\d{4})-(\d{2})-(\d{2})$/.exec(today)!;
    dueMs = zonedWallClockToMs(+t[1]!, +t[2]!, +t[3]!, 9, 0, opts.timeZone);
  }

  const readable = new Intl.DateTimeFormat('es-MX', { weekday: 'long', day: 'numeric', month: 'long', timeZone: opts.timeZone }).format(new Date(requestedMs));
  const summary = opts.summary?.trim();
  return {
    title: `Lista de espera: agendar para ${readable}`,
    body:
      `${summary ? `${summary}\n\n` : ''}La lead pidió una fecha fuera de la ventana de agenda y quedó anotada en lista de espera. ` +
      `Escribirle para apartar su lugar en cuanto esa fecha abra. Anotada por el asistente de ${opts.businessName}.`,
    dueDate: new Date(dueMs).toISOString(),
    dueDay: wallKey(dueMs, opts.timeZone) ?? new Date(dueMs).toISOString().slice(0, 10),
  };
}
