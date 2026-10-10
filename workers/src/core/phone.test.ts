import { describe, it, expect } from 'vitest';
import { isMexicanAreaCode, normalizeLeadPhone, phoneRefusalNote } from './phone.js';

describe('normalizeLeadPhone — Mexico assumed, never guessed', () => {
  it('10 digits with a Mexican LADA → +52 (Tijuana, Chihuahua, CDMX 2-digit)', () => {
    expect(normalizeLeadPhone('664 123 4567')).toEqual({ ok: true, e164: '+526641234567', assumedMexico: true });
    expect(normalizeLeadPhone('6141234567')).toEqual({ ok: true, e164: '+526141234567', assumedMexico: true });
    expect(normalizeLeadPhone('55-1234-5678')).toEqual({ ok: true, e164: '+525512345678', assumedMexico: true });
  });

  it('52 + 10 digits → + added; 521 + 10 (legacy mobile 1) → the 1 is dropped', () => {
    expect(normalizeLeadPhone('526641234567')).toEqual({ ok: true, e164: '+526641234567', assumedMexico: false });
    expect(normalizeLeadPhone('5216641234567')).toEqual({ ok: true, e164: '+526641234567', assumedMexico: false });
  });

  it('an explicit + is respected for any country', () => {
    expect(normalizeLeadPhone('+1 619 555 0100')).toEqual({ ok: true, e164: '+16195550100', assumedMexico: false });
    expect(normalizeLeadPhone('+34 600 000 000')).toEqual({ ok: true, e164: '+34600000000', assumedMexico: false });
  });

  it('refuses instead of guessing: short, unknown LADA, US shape without +', () => {
    expect(normalizeLeadPhone('12345')).toEqual({ ok: false, reason: 'too_short' });
    expect(normalizeLeadPhone('664 123 456')).toEqual({ ok: false, reason: 'too_short' });
    // 619 (San Diego) is not a Mexican LADA → ask, don't send reminders to a stranger.
    expect(normalizeLeadPhone('6195550100')).toEqual({ ok: false, reason: 'unknown_area_code' });
    // 11 digits starting with 1 = NANP without the +.
    expect(normalizeLeadPhone('16195550100')).toEqual({ ok: false, reason: 'not_mexican_shape' });
    expect(normalizeLeadPhone('+12')).toEqual({ ok: false, reason: 'too_short' });
  });

  it('isMexicanAreaCode knows the 2-digit metros and a sample of 3-digit codes', () => {
    for (const n of ['5512345678', '3312345678', '8112345678', '6641234567', '9981234567', '4421234567']) {
      expect(isMexicanAreaCode(n)).toBe(true);
    }
    expect(isMexicanAreaCode('6195550100')).toBe(false);
    expect(isMexicanAreaCode('0001234567')).toBe(false);
  });

  it('the refusal note tells the model to ask, and to retry with the same slot', () => {
    for (const reason of ['too_short', 'unknown_area_code', 'not_mexican_shape'] as const) {
      const note = phoneRefusalNote(reason);
      expect(note).toMatch(/No agendé todavía/);
      expect(note).toMatch(/de México/);
      expect(note).toMatch(/vuelve a llamar bookAppointment con el mismo horario/);
    }
  });
});
