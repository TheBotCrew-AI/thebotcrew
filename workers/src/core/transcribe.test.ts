import { describe, it, expect } from 'vitest';
import { buildTranscriptionPrompt } from './transcribe.js';

describe('buildTranscriptionPrompt', () => {
  // Measured on a real 2.4 KB voice note ("sí, agendan citas"): with no prompt,
  // gpt-4o-mini-transcribe returned "Siahendazi."; with one, "Se agenda cita."
  it('always sets the Spanish business context', () => {
    const p = buildTranscriptionPrompt();
    expect(p).toContain('español');
    expect(p).toContain('citas');
  });

  it("includes the tenant's name and service vocabulary", () => {
    const p = buildTranscriptionPrompt({
      businessName: 'MADI Skin Care',
      terms: ['HydraFacial', 'Depilación Láser Diodo'],
    });
    expect(p).toContain('MADI Skin Care');
    expect(p).toContain('HydraFacial');
    expect(p).toContain('Depilación Láser Diodo');
  });

  it('caps the term list and total length (the API ignores a long prompt)', () => {
    const p = buildTranscriptionPrompt({
      businessName: 'X'.repeat(200),
      terms: Array.from({ length: 40 }, (_, i) => `Servicio-${i}`),
    });
    expect(p.length).toBeLessThanOrEqual(700);
    expect(p).not.toContain('Servicio-20');
  });

  it('drops blank terms instead of emitting empty slots', () => {
    const p = buildTranscriptionPrompt({ terms: ['  ', '', 'Botox'] });
    expect(p).toContain('Botox');
    expect(p).not.toContain(', ,');
  });
});
