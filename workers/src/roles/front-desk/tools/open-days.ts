/**
 * Which weekdays the business actually opens, read from the tenant's own `hours`.
 *
 * WHY THIS EXISTS: GHL returns zero slots for a day the business is CLOSED and for a day
 * that is FULL, and getAvailability used to report both the same way ("Sin disponibilidad
 * en el rango consultado"). The model then wrote the warm version of that — "para el sábado
 * ya no tengo espacios" — to a lead who had asked whether Saturdays are attended at all
 * (Dr. Valdivia, Instagram, 2026-09-21; the clinic is Mon–Fri and never opens Saturday).
 * A "full" that is really a "closed" is a lie the lead acts on: she waits and asks again
 * for the next Saturday. So the closed case is resolved HERE, deterministically, from
 * config the prompt already renders — not left to the model to infer from an empty list.
 *
 * Pure (no I/O), so it is unit-tested at Layer 1.
 */

/** Weekday config keys with their Spanish labels, in week order (the order callers group by). */
export const WEEKDAY_LABEL: Record<string, string> = {
  mon: 'Lunes',
  tue: 'Martes',
  wed: 'Miércoles',
  thu: 'Jueves',
  fri: 'Viernes',
  sat: 'Sábado',
  sun: 'Domingo',
};

const WEEKDAY_ORDER = Object.keys(WEEKDAY_LABEL);
/** 12 h keeps the walk inside every calendar day, DST shifts included. */
const STEP_MS = 12 * 60 * 60 * 1000;
/** A range longer than this certainly contains an open day; stop walking and don't gate. */
const MAX_STEPS = 64;

export interface ClosedRange {
  /** Weekday keys the requested range covers — every one of them closed. */
  closed: string[];
  /** Weekday keys the business does open, in week order. */
  open: string[];
}

/** The weekday config key (`mon`…`sun`) of an instant, in the business's clock. */
export function weekdayKeyInZone(ms: number, timeZone: string): string | null {
  try {
    const short = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(new Date(ms));
    const key = short.slice(0, 3).toLowerCase();
    return key in WEEKDAY_LABEL ? key : null;
  } catch {
    return null;
  }
}

/**
 * The distinct weekday keys a `[fromMs, toMs)` range touches, in the business's clock.
 * Half-open on purpose: a range ending at local midnight (the shape the model writes for
 * "el sábado") must not drag Sunday in. Returns null when the range can't be enumerated —
 * a bad zone, or one long enough that the answer can't be "all closed" anyway.
 */
export function weekdaysInRange(fromMs: number, toMs: number, timeZone: string): string[] | null {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) return null;
  const seen = new Set<string>();
  let steps = 0;
  for (let t = fromMs; t < toMs; t += STEP_MS) {
    if (++steps > MAX_STEPS) return null;
    const key = weekdayKeyInZone(t, timeZone);
    if (!key) return null;
    seen.add(key);
  }
  // The final instant of the range belongs to it too (a range shorter than one step
  // would otherwise be read from its start alone, which is already covered above).
  const last = weekdayKeyInZone(toMs - 1, timeZone);
  if (!last) return null;
  seen.add(last);
  return [...seen];
}

/** Weekday keys with at least one open interval configured. */
export function openWeekdays(hours: Record<string, { open: string; close: string }[]>): string[] {
  return WEEKDAY_ORDER.filter((d) => (hours[d]?.length ?? 0) > 0);
}

/**
 * The range asked for falls ENTIRELY on days the business does not open → the facts the
 * caller needs to say so. null when the check does not apply, and the caller proceeds as
 * before. It deliberately does not apply when:
 * - `hours` configures no open day at all (unknown schedule, not a closed one — gating on
 *   it would make an unconfigured tenant claim it never opens),
 * - the range can't be enumerated, or
 * - any day in it is open (a Friday–Saturday range is answered by Friday's real slots).
 */
export function closedRange(
  fromMs: number,
  toMs: number,
  timeZone: string,
  hours: Record<string, { open: string; close: string }[]>,
): ClosedRange | null {
  const open = openWeekdays(hours);
  if (open.length === 0) return null;
  const days = weekdaysInRange(fromMs, toMs, timeZone);
  if (!days) return null;
  if (days.some((d) => open.includes(d))) return null;
  const closed = WEEKDAY_ORDER.filter((d) => days.includes(d));
  return closed.length > 0 ? { closed, open } : null;
}

/** "sábado" / "sábado y domingo" / "sábado, domingo y lunes" — lowercase, for prose. */
export function dayListEs(keys: string[]): string {
  const names = keys.map((k) => (WEEKDAY_LABEL[k] ?? k).toLowerCase());
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} y ${names[names.length - 1]}`;
}

/** "de lunes a viernes" when the open days run contiguous, else the plain list. */
export function openDaysEs(keys: string[]): string {
  const idx = keys.map((k) => WEEKDAY_ORDER.indexOf(k));
  const contiguous = idx.every((i, n) => i >= 0 && (n === 0 || i === idx[n - 1]! + 1));
  if (contiguous && keys.length >= 3) {
    const first = (WEEKDAY_LABEL[keys[0]!] ?? '').toLowerCase();
    const last = (WEEKDAY_LABEL[keys[keys.length - 1]!] ?? '').toLowerCase();
    return `de ${first} a ${last}`;
  }
  return dayListEs(keys);
}
