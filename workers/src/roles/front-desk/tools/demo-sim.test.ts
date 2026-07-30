import { describe, it, expect } from 'vitest';
import { simSlotLabel, simulatedSlots } from './demo-sim.js';

const TZ = 'America/Mexico_City';
// A fixed Wednesday 12:00 UTC (2026-07-29) — the following 3 days are Thu/Fri/Sat, no Sunday.
const WED = Date.parse('2026-07-29T12:00:00Z');
// A Friday: the 3-day lookahead crosses Sunday (2026-08-02), which must be skipped.
const FRI = Date.parse('2026-07-31T12:00:00Z');

describe('simulatedSlots', () => {
  it('is deterministic for the same conversation and day', () => {
    const a = simulatedSlots('conv1', TZ, WED);
    const b = simulatedSlots('conv1', TZ, WED);
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(0);
  });

  it('differs between conversations (not one global fake calendar)', () => {
    const a = simulatedSlots('conv1', TZ, WED).map((s) => s.start);
    const b = simulatedSlots('conv2', TZ, WED).map((s) => s.start);
    expect(a).not.toEqual(b);
  });

  it('drops 1-2 slots per day so the calendar reads plausibly busy', () => {
    const slots = simulatedSlots('conv1', TZ, WED);
    // 3 days × 5 daily times, minus at least 1 taken per day.
    expect(slots.length).toBeLessThan(15);
    expect(slots.length).toBeGreaterThanOrEqual(9);
  });

  it('skips Sundays', () => {
    const slots = simulatedSlots('conv1', TZ, FRI);
    const weekdays = slots.map((s) =>
      new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' }).format(new Date(s.start)),
    );
    expect(weekdays).not.toContain('Sun');
  });

  it('labels are tenant-tz wall-clock at the configured times', () => {
    const slots = simulatedSlots('conv1', TZ, WED);
    for (const s of slots) {
      const local = new Intl.DateTimeFormat('en-CA', {
        timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false,
      }).format(new Date(s.start));
      expect(['10:00', '11:30', '13:00', '16:00', '17:30']).toContain(local);
      expect(s.label).toBe(simSlotLabel(s.start, TZ));
    }
  });

  it('excludes the already-booked simulated slot', () => {
    const all = simulatedSlots('conv1', TZ, WED);
    const booked = all[0]!.start;
    const after = simulatedSlots('conv1', TZ, WED, booked);
    expect(after.map((s) => s.start)).not.toContain(booked);
    expect(after.length).toBe(all.length - 1);
  });
});
