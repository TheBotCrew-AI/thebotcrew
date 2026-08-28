import { describe, it, expect } from 'vitest';
import { slotLabel } from './slot-label.js';

// 18:00Z on 2026-09-03 (a Thursday): 11:00 a.m. Tijuana (-07:00), 12:00 p.m. Mexico City, 1:00 p.m. Cancún.
const ISO = '2026-09-03T18:00:00.000Z';

describe('slotLabel', () => {
  it('weekday + date + time in the frame zone', () => {
    expect(slotLabel(ISO, 'America/Tijuana', 'America/Tijuana')).toMatch(/^jueves,? 3 de septiembre,? 11:00 a\.?\s?m\.$/);
  });

  it('adds the "hora de …" suffix only when the lead reads a different clock', () => {
    expect(slotLabel(ISO, 'America/Cancun', 'America/Tijuana')).toMatch(/1:00 p\.?\s?m\. hora de Cancún$/);
    expect(slotLabel(ISO, 'America/Mexico_City', 'America/Mexico_City')).not.toContain('hora de');
  });

  it('returns the input untouched when it is not a date', () => {
    expect(slotLabel('mañana', 'America/Tijuana', 'America/Tijuana')).toBe('mañana');
  });
});
