/**
 * Prime time reserved for paying services (0066).
 *
 * WHY THIS EXISTS: the busiest hours of the week (the after-work slots) are where a clinic
 * makes its money, and a free valoración booked at 6 p.m. displaces a paying patient. The
 * rule the business wants is a soft one — offer the free lead the off-peak slots first, and
 * give them a prime slot only when none of the others works — and a soft withhold-rule left
 * to the model is exactly the class that fails at a rate (see business-logic §6c). So it is
 * settled HERE: `getAvailability` hides the prime slots of a restricted service unless the
 * model asks for them on the lead's refusal, asking logs `prime_time_released`, and the
 * booking tools refuse a prime slot for a restricted service without that event.
 *
 * Pure (no I/O), unit-tested at Layer 1.
 */

import { z } from 'zod';
import { slotWallKey } from './booking-time.js';
import { WEEKDAY_LABEL, weekdayKeyInZone } from './open-days.js';

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export const primeTimeWindowSchema = z.object({
  /** Weekday config keys (`mon`…`sun`). */
  days: z.array(z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'])).min(1),
  /** Wall-clock in the tenant's timezone, `HH:MM`; a slot is prime when `start <= slot < end`. */
  start: z.string().regex(HHMM),
  end: z.string().regex(HHMM),
});

export const primeTimeSchema = z.object({
  windows: z.array(primeTimeWindowSchema).min(1),
  /** Exact `services[].name` values kept OUT of the windows until the lead refuses the rest. */
  restrictedServices: z.array(z.string().min(1)).min(1),
});
export type PrimeTimeConfig = z.infer<typeof primeTimeSchema>;
export type PrimeTimeWindow = z.infer<typeof primeTimeWindowSchema>;

/**
 * The stored jsonb is snake_case (like booking_payment); malformed → null + a loud log.
 * Null = feature off: a bad row makes every slot visible to every service, which is the
 * pre-0066 behavior, whereas throwing would kill every turn for the tenant.
 */
export function parsePrimeTime(raw: unknown): PrimeTimeConfig | null {
  if (raw == null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    console.error('[prime-time] tenant_config.prime_time is not an object — feature off');
    return null;
  }
  const o = raw as Record<string, unknown>;
  const parsed = primeTimeSchema.safeParse({
    windows: o.windows,
    restrictedServices: o.restricted_services ?? o.restrictedServices,
  });
  if (!parsed.success) {
    console.error('[prime-time] tenant_config.prime_time invalid — feature off:', parsed.error.message);
    return null;
  }
  return parsed.data;
}

const toMinutes = (hhmm: string): number => {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

/** Whether this service is one the windows are kept from. */
export function isRestrictedService(prime: PrimeTimeConfig | null | undefined, serviceName: string): boolean {
  return !!prime && prime.restrictedServices.includes(serviceName);
}

/**
 * Whether a slot's START falls inside a prime window, read in the TENANT's clock — it is the
 * business's busy hour, not the lead's (§5d). An unreadable instant or zone is not prime: a
 * broken zone must not hide every slot from a restricted service.
 */
export function isPrimeSlot(startIso: string, prime: PrimeTimeConfig, timeZone: string): boolean {
  const ms = Date.parse(startIso);
  if (Number.isNaN(ms)) return false;
  const day = weekdayKeyInZone(ms, timeZone);
  const wall = slotWallKey(startIso, timeZone);
  const m = wall ? /T(\d{2}):(\d{2})/.exec(wall) : null;
  if (!day || !m) return false;
  const minutes = Number(m[1]) * 60 + Number(m[2]);
  return prime.windows.some(
    (w) => w.days.includes(day as PrimeTimeWindow['days'][number]) && minutes >= toMinutes(w.start) && minutes < toMinutes(w.end),
  );
}

/** The slots a restricted service may see right away, and the ones held back. */
export function splitPrimeSlots<T extends { start: string }>(
  slots: T[],
  prime: PrimeTimeConfig,
  timeZone: string,
): { offPeak: T[]; prime: T[] } {
  const offPeak: T[] = [];
  const held: T[] = [];
  for (const s of slots) (isPrimeSlot(s.start, prime, timeZone) ? held : offPeak).push(s);
  return { offPeak, prime: held };
}

/** "lunes a viernes de 5:00 p.m. a 8:00 p.m." — for the prompt and the tool notes. */
export function primeWindowsEs(prime: PrimeTimeConfig): string {
  const hour = (hhmm: string): string => {
    const [h = 0, m = 0] = hhmm.split(':').map(Number);
    const suffix = h >= 12 ? 'p.m.' : 'a.m.';
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return `${h12}:${String(m).padStart(2, '0')} ${suffix}`;
  };
  return prime.windows
    .map((w) => {
      const names = w.days.map((d) => (WEEKDAY_LABEL[d] ?? d).toLowerCase());
      const days = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} y ${names[names.length - 1]}`;
      return `${days} de ${hour(w.start)} a ${hour(w.end)}`;
    })
    .join('; ');
}
