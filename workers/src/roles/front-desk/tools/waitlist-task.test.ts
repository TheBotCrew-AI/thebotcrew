import { describe, it, expect } from 'vitest';
import { buildWaitlistTask } from './waitlist-task.js';

const TZ = 'America/Chihuahua';
/** Monday 2026-10-19, 12:00 in Chihuahua. */
const NOW = Date.parse('2026-10-19T18:00:00Z');
const base = { horizonDays: 7, nowMs: NOW, timeZone: TZ, businessName: 'Dr. Heriberto Valdivia' };

describe('buildWaitlistTask', () => {
  it('falls due the day the requested date enters the window (date − horizon), 9:00 local', () => {
    const t = buildWaitlistTask('2026-11-03', { ...base, summary: 'lista de espera: martes 3 de noviembre — láser' });
    expect(t?.dueDay).toBe('2026-10-27');
    expect(t?.dueDate).toBe('2026-10-27T15:00:00.000Z'); // 09:00 CST (-06:00)
    expect(t?.title).toBe('Lista de espera: agendar para martes, 3 de noviembre');
    expect(t?.body).toContain('lista de espera: martes 3 de noviembre — láser');
  });

  it('a date already inside the window is due today, never in the past', () => {
    expect(buildWaitlistTask('2026-10-22', base)?.dueDay).toBe('2026-10-19');
  });

  it('no horizon → due on the requested day itself', () => {
    expect(buildWaitlistTask('2026-11-03', { ...base, horizonDays: null })?.dueDay).toBe('2026-11-03');
  });

  it('free text is not a date → null (no task on an invented day)', () => {
    expect(buildWaitlistTask('la semana que entra', base)).toBeNull();
    expect(buildWaitlistTask('3 de noviembre', base)).toBeNull();
  });
});
