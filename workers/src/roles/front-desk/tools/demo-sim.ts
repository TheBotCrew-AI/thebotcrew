/**
 * Simulated availability/booking for demo mode (active_role='demo').
 *
 * A demo must never touch a real calendar: no GHL calls (nothing can 401/500 in
 * front of a prospect), no appointments rows (nothing to clean up), and no risk
 * of holding a real slot. Slots are generated business-plausible and
 * DETERMINISTIC per (conversation, day) — the model re-queries availability
 * mid-flow, and slots that shuffle between calls read as a broken product.
 *
 * The demo booking flow reuses the same anti-hallucination shape as the real
 * one: the tool re-derives the slot list and only "books" the exact slot string
 * that matches the lead's pick (see resolveBookableSlot in the tool branches).
 */

import { zonedWallClockToMs } from './booking-time.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Wall-clock times offered each day (minutes from midnight, tenant-local). */
const DAILY_TIMES: ReadonlyArray<{ h: number; m: number }> = [
  { h: 10, m: 0 },
  { h: 11, m: 30 },
  { h: 13, m: 0 },
  { h: 16, m: 0 },
  { h: 17, m: 30 },
];
const SLOT_MINUTES = 45;
/** Offer slots on the next N days (Sundays closed — plausibility, not policy). */
const DAYS_AHEAD = 3;

/** FNV-1a — a stable, dependency-free hash for the determinism seed. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** The tz's wall-clock fields for an instant (en-CA gives ISO-ordered parts). */
function wallClock(ms: number, timeZone: string): { y: number; mo: number; d: number; h: number; mi: number; weekday: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    weekday: 'short',
  }).formatToParts(new Date(ms));
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? '0';
  const weekdayIdx = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  return {
    y: Number(get('year')),
    mo: Number(get('month')),
    d: Number(get('day')),
    h: Number(get('hour')) % 24, // en-CA can emit "24" for midnight
    mi: Number(get('minute')),
    weekday: weekdayIdx,
  };
}

// The wall-clock → instant conversion lives in booking-time.ts (zonedWallClockToMs):
// one implementation, shared with the availability window resolver and unit-tested there.

export interface SimSlot {
  start: string;
  end: string;
  label: string;
}

/** Human label in the tenant tz — same format the real getAvailability emits. */
export function simSlotLabel(iso: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('es-MX', {
      timeZone,
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

/**
 * Plausible free slots for the next few days: a few times per day, minus 1-2
 * pseudo-taken ones (deterministic per conversation+day — a fully-open calendar
 * reads fake), minus the already-simulated booking if one exists.
 */
export function simulatedSlots(
  seedKey: string,
  timeZone: string,
  nowMs: number,
  excludeStart?: string,
): SimSlot[] {
  const excludeMs = excludeStart ? Date.parse(excludeStart) : NaN;
  const slots: SimSlot[] = [];

  for (let offset = 1; offset <= DAYS_AHEAD; offset++) {
    const day = wallClock(nowMs + offset * DAY_MS, timeZone);
    if (day.weekday === 0) continue; // Sundays closed

    const daySeed = fnv1a(`${seedKey}:${day.y}-${day.mo}-${day.d}`);
    // Drop 1-2 slots per day, position derived from the seed.
    const takenA = daySeed % DAILY_TIMES.length;
    const takenB = daySeed % 2 === 0 ? (takenA + 2) % DAILY_TIMES.length : -1;

    for (const [i, t] of DAILY_TIMES.entries()) {
      if (i === takenA || i === takenB) continue;
      const startMs = zonedWallClockToMs(day.y, day.mo, day.d, t.h, t.m, timeZone);
      if (Number.isFinite(excludeMs) && startMs === excludeMs) continue;
      const start = new Date(startMs).toISOString();
      slots.push({
        start,
        end: new Date(startMs + SLOT_MINUTES * 60 * 1000).toISOString(),
        label: simSlotLabel(start, timeZone),
      });
    }
  }
  return slots;
}
