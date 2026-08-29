/**
 * A stand-in for `GhlClient` with a calendar that behaves: free slots come from the
 * tenant's real opening hours (30-minute grid, a deterministic share of them "taken"),
 * a booking removes its slot, a cancel/reschedule moves it, and `getContactAppointments`
 * reports what was booked — so `bookAppointment`'s re-validation, the self-block guard
 * and the "¿a qué hora era mi cita?" path all work exactly as in prod, on a calendar
 * that belongs to nobody.
 */

import type { Slot } from '../ghl/types.js';
import type { AppointmentLogRow } from '../db/appointment-active.js';
import { offsetMinutes } from '../core/lead-timezone.js';
import { zonedWallClockToMs } from '../roles/front-desk/tools/booking-time.js';
import type { FakeAppointment } from './scenario.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const SLOT_MIN = 30;
/** Share of slots marked as taken (deterministic per slot), so the calendar reads real. */
const BUSY_RATIO = 0.35;
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

type Hours = Record<string, Array<{ open: string; close: string }>>;

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/** `2026-09-01T11:00:00-06:00` — the shape GHL's free-slots endpoint returns. */
export function isoWithOffset(ms: number, timeZone: string): string {
  const off = offsetMinutes(timeZone, new Date(ms)) ?? 0;
  const local = new Date(ms + off * 60000);
  const p = (n: number) => String(n).padStart(2, '0');
  const sign = off < 0 ? '-' : '+';
  const a = Math.abs(off);
  return (
    `${local.getUTCFullYear()}-${p(local.getUTCMonth() + 1)}-${p(local.getUTCDate())}` +
    `T${p(local.getUTCHours())}:${p(local.getUTCMinutes())}:00${sign}${p(Math.floor(a / 60))}:${p(a % 60)}`
  );
}

function localDate(ms: number, timeZone: string): { y: number; m: number; d: number; weekday: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
  }).formatToParts(new Date(ms));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const wd = get('weekday').toLowerCase().slice(0, 3);
  return { y: Number(get('year')), m: Number(get('month')), d: Number(get('day')), weekday: WEEKDAYS.indexOf(wd as (typeof WEEKDAYS)[number]) };
}

export class FakeGhl {
  readonly appointments: FakeAppointment[] = [];
  readonly tags = new Set<string>();
  contactName?: { firstName: string; lastName: string };
  contactTimezone?: string;
  /** Our `appointments` table as the tools would see it (fed to the mocked loadAppointmentLog). */
  readonly appointmentLog: AppointmentLogRow[] = [];
  private seq = 0;

  constructor(
    private readonly opts: { timezone: string; hours: Hours; phone?: string; nowMs?: number },
  ) {}

  private now(): number {
    return this.opts.nowMs ?? Date.now();
  }

  /** Every bookable instant between `from` and `to`, taken ones excluded. */
  private grid(fromMs: number, toMs: number): number[] {
    const out: number[] = [];
    const tz = this.opts.timezone;
    for (let t = fromMs - DAY_MS; t <= toMs + DAY_MS; t += DAY_MS) {
      const { y, m, d, weekday } = localDate(t, tz);
      const ranges = this.opts.hours[WEEKDAYS[weekday]!] ?? [];
      for (const r of ranges) {
        const [oh, om] = r.open.split(':').map(Number) as [number, number];
        const [ch, cm] = r.close.split(':').map(Number) as [number, number];
        const open = zonedWallClockToMs(y, m, d, oh, om, tz);
        const close = zonedWallClockToMs(y, m, d, ch, cm, tz);
        for (let s = open; s + SLOT_MIN * 60000 <= close; s += SLOT_MIN * 60000) {
          if (s < fromMs || s > toMs) continue;
          // A real calendar has patients in it: skip a stable share of the grid.
          if ((fnv1a(String(s)) % 100) / 100 < BUSY_RATIO) continue;
          out.push(s);
        }
      }
    }
    return out;
  }

  private isTaken(ms: number): boolean {
    return this.appointments.some((a) => a.status === 'confirmed' && Date.parse(a.startTime) === ms);
  }

  /** Book straight into the calendar (a scenario preset), bypassing the agent. */
  seedAppointment(input: { calendarId: string; serviceName: string; startTime: string }): FakeAppointment {
    const appt: FakeAppointment = {
      id: `appt_seed_${++this.seq}`,
      calendarId: input.calendarId,
      serviceName: input.serviceName,
      startTime: input.startTime,
      status: 'confirmed',
    };
    this.appointments.push(appt);
    this.appointmentLog.unshift({
      ghlAppointmentId: appt.id,
      action: 'booked',
      appointmentDatetime: appt.startTime,
      serviceType: appt.serviceName ?? null,
      createdAt: new Date(this.now() - DAY_MS).toISOString(),
    });
    return appt;
  }

  /** The first free slot at (or after) a wall-clock time on a day `daysAhead` from now. */
  slotAt(daysAhead: number, time: string): string {
    const [h, mi] = time.split(':').map(Number) as [number, number];
    const { y, m, d } = localDate(this.now() + daysAhead * DAY_MS, this.opts.timezone);
    const want = zonedWallClockToMs(y, m, d, h, mi, this.opts.timezone);
    const candidates = this.grid(want, want + 14 * DAY_MS).filter((s) => !this.isTaken(s));
    const pick = candidates[0];
    if (pick === undefined) throw new Error(`no free slot at or after ${time} +${daysAhead}d`);
    return isoWithOffset(pick, this.opts.timezone);
  }

  // ---- the GhlClient surface the front-desk tools call -----------------------------------

  async getAvailability(_calendarId: string, from: string, to: string): Promise<Slot[]> {
    const fromMs = Math.max(Date.parse(from), this.now() + 60 * 60000); // GHL: no same-hour slots
    const toMs = Date.parse(to);
    return this.grid(fromMs, toMs)
      .filter((s) => !this.isTaken(s))
      .map((s) => {
        const iso = isoWithOffset(s, this.opts.timezone);
        return { start: iso, end: iso };
      });
  }

  async bookAppointment(input: { calendarId: string; startTime: string; title?: string }): Promise<{ ghlAppointmentId: string }> {
    const appt: FakeAppointment = {
      id: `appt_${++this.seq}`,
      calendarId: input.calendarId,
      serviceName: input.title,
      startTime: input.startTime,
      status: 'confirmed',
    };
    this.appointments.push(appt);
    return { ghlAppointmentId: appt.id };
  }

  async rescheduleAppointment(input: { appointmentId: string; startTime: string }): Promise<void> {
    const appt = this.appointments.find((a) => a.id === input.appointmentId);
    if (!appt) throw new Error(`[fake-ghl] rescheduleAppointment: unknown id ${input.appointmentId}`);
    appt.startTime = input.startTime;
  }

  async cancelAppointment(appointmentId: string): Promise<void> {
    const appt = this.appointments.find((a) => a.id === appointmentId);
    if (!appt) throw new Error(`[fake-ghl] cancelAppointment: unknown id ${appointmentId}`);
    appt.status = 'cancelled';
  }

  async getAppointment(appointmentId: string): Promise<{ startTime?: string; status?: string; title?: string }> {
    const appt = this.appointments.find((a) => a.id === appointmentId);
    if (!appt) throw new Error(`[fake-ghl] getAppointment failed 404: ${appointmentId}`);
    return { startTime: appt.startTime, status: appt.status, title: appt.serviceName };
  }

  async getContactAppointments(): Promise<
    Array<{ id: string; startTime?: string; endTime?: string; status?: string; calendarId?: string; title?: string; deleted?: boolean }>
  > {
    return this.appointments.map((a) => ({
      id: a.id, startTime: a.startTime, status: a.status, calendarId: a.calendarId, title: a.serviceName, deleted: false,
    }));
  }

  async addContactTags(_contactId: string, tags: string[]): Promise<void> {
    for (const t of tags) this.tags.add(t);
  }

  async removeContactTags(_contactId: string, tags: string[]): Promise<void> {
    for (const t of tags) this.tags.delete(t);
  }

  async getContactPhone(): Promise<string | undefined> {
    return this.opts.phone;
  }

  async updateContactPhone(): Promise<void> {}

  async updateContactName(_contactId: string, name: { firstName: string; lastName: string }): Promise<void> {
    this.contactName = name;
  }

  async updateContactTimezone(_contactId: string, timezone: string): Promise<void> {
    this.contactTimezone = timezone;
  }

  async getContact(): Promise<{ name?: string; phone?: string } | undefined> {
    return { phone: this.opts.phone };
  }
}
