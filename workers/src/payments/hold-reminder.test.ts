import { describe, it, expect } from 'vitest';
import { holdReminderAt } from './hold-reminder.js';

// Tijuana (PDT, UTC−7 in September). Local wall-clock helpers keep the table readable.
const TZ = 'America/Tijuana';
const H = 3600_000;
const local = (day: string, hhmm: string): number => Date.parse(`2026-09-${day}T${hhmm}:00-07:00`);
const base = { timeZone: TZ, hoursBefore: 3 };

describe('holdReminderAt — the table from the design (Tijuana, quiet 21:00–08:00)', () => {
  it('books 16:00 for tomorrow 10:00 → due 08:00 → target 05:00 is quiet → 20:30 the evening before', () => {
    expect(holdReminderAt({ ...base, createdMs: local('22', '16:00'), dueMs: local('23', '08:00') })).toBe(local('22', '20:30'));
  });

  it('books 22:00 for tomorrow 16:00 → due 14:00 → 11:00, awake, as is', () => {
    expect(holdReminderAt({ ...base, createdMs: local('22', '22:00'), dueMs: local('23', '14:00') })).toBe(local('23', '11:00'));
  });

  it('books 09:00 for today 15:00 → due 13:00 → 10:00', () => {
    expect(holdReminderAt({ ...base, createdMs: local('22', '09:00'), dueMs: local('22', '13:00') })).toBe(local('22', '10:00'));
  });

  it('books 12:00 for today 15:00 → due 13:00 → nothing fits → null', () => {
    expect(holdReminderAt({ ...base, createdMs: local('22', '12:00'), dueMs: local('22', '13:00') })).toBeNull();
  });

  it('books 11:00 for the day after tomorrow 11:00 → due tomorrow 11:00 → 08:00 tomorrow', () => {
    expect(holdReminderAt({ ...base, createdMs: local('22', '11:00'), dueMs: local('23', '11:00') })).toBe(local('23', '08:00'));
  });

  it('target before "created + 1 h" is clamped up: books 06:00 for 12:00 (due 10:00) → 07:00 is quiet → 08:00', () => {
    expect(holdReminderAt({ ...base, createdMs: local('22', '06:00'), dueMs: local('22', '10:00') })).toBe(local('22', '08:00'));
  });

  it('evening slot that would be BEFORE creation is skipped for the morning: books 23:00 for tomorrow 10:30 (due 08:30) → 08:00? no, too close → null', () => {
    // due 08:30 → target 05:30 (quiet) → evening 20:30 yesterday < created → morning 08:00 leaves 30 min < 1 h → null
    expect(holdReminderAt({ ...base, createdMs: local('22', '23:00'), dueMs: local('23', '08:30') })).toBeNull();
  });

  it('hoursBefore 0 → off; custom quiet hours are honoured', () => {
    expect(holdReminderAt({ ...base, hoursBefore: 0, createdMs: local('22', '09:00'), dueMs: local('23', '09:00') })).toBeNull();
    // Quiet 22:00–07:00: the 05:00 target moves to 21:30 the evening before.
    expect(holdReminderAt({ ...base, quietHours: { start: 22, end: 7 }, createdMs: local('22', '16:00'), dueMs: local('23', '08:00') })).toBe(local('22', '21:30'));
  });

  it('never later than due − 1 h, never earlier than created + 1 h', () => {
    const r = holdReminderAt({ ...base, createdMs: local('22', '09:00'), dueMs: local('22', '13:00') })!;
    expect(r).toBeGreaterThanOrEqual(local('22', '09:00') + H);
    expect(r).toBeLessThanOrEqual(local('22', '13:00') - H);
  });
});
