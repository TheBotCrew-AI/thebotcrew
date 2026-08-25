import { describe, it, expect } from 'vitest';
import { buildExtractionPrompt, parseExtraction, renderTranscript, type TranscriptLine } from './extract.js';

const lines: TranscriptLine[] = [
  { sender: 'lead', at: '2026-08-10T23:16:00Z', text: 'Tendría que pagar 2400 ya' },
  { sender: 'bot', at: '2026-08-10T23:16:30Z', text: 'Déjame lo confirmo con el equipo y te aviso.' },
  { sender: 'human', at: '2026-08-10T23:35:00Z', text: 'El costo de la sesión para bikini es de 500 pesos' },
];

describe('renderTranscript', () => {
  it('labels senders and keeps chronological order', () => {
    const out = renderTranscript(lines);
    expect(out.split('\n')).toEqual([
      '2026-08-10 23:16 [LEAD] Tendría que pagar 2400 ya',
      '2026-08-10 23:16 [BOT] Déjame lo confirmo con el equipo y te aviso.',
      '2026-08-10 23:35 [HUMANO] El costo de la sesión para bikini es de 500 pesos',
    ]);
  });

  it('keeps the NEWEST lines when the transcript exceeds the cap', () => {
    const many: TranscriptLine[] = Array.from({ length: 400 }, (_, i) => ({
      sender: 'lead',
      at: `2026-08-01T00:${String(i % 60).padStart(2, '0')}:00Z`,
      text: `mensaje ${i} ${'x'.repeat(120)}`,
    }));
    const out = renderTranscript(many);
    expect(out).toContain('mensaje 399');
    expect(out).not.toContain('mensaje 0 ');
    expect(out.length).toBeLessThanOrEqual(14_100);
  });
});

describe('buildExtractionPrompt', () => {
  it('carries the tenant\'s current knowledge so the model can judge already_in_config', () => {
    const prompt = buildExtractionPrompt({
      businessName: 'MADI Skin Care',
      transcript: lines,
      offering: 'Axilas: $2,300 (6 sesiones)',
      faq: [{ q: '¿Dónde están?', a: 'Plaza Financiera' }],
      hours: '- Lunes: 08:00–19:00',
    });
    expect(prompt).toContain('MADI Skin Care');
    expect(prompt).toContain('Axilas: $2,300');
    expect(prompt).toContain('P: ¿Dónde están?');
    expect(prompt).toContain('Lunes: 08:00–19:00');
    expect(prompt).toContain('[HUMANO] El costo de la sesión');
    // json_object mode requires the word JSON in the prompt.
    expect(prompt).toMatch(/JSON/);
  });

  it('renders empty knowledge explicitly rather than as blank sections', () => {
    const prompt = buildExtractionPrompt({ businessName: 'X', transcript: [], offering: '', faq: [], hours: '' });
    expect(prompt).toContain('(vacío)');
    expect(prompt).toContain('(sin FAQ)');
    expect(prompt).toContain('(sin horario)');
  });
});

describe('parseExtraction', () => {
  const good = {
    gaps: [
      {
        question: 'Tendría que pagar 2400 ya',
        topic: 'formas_pago',
        topic_label: 'pago por sesion',
        human_answer: 'Por sesión son $500',
        already_in_config: false,
        target: 'offering',
        suggested_text: 'El paquete se paga completo en la primera sesión; por sesión, $500.',
      },
    ],
  };

  it('accepts the documented shape, with or without a code fence', () => {
    expect(parseExtraction(JSON.stringify(good))).toEqual(good);
    expect(parseExtraction('```json\n' + JSON.stringify(good) + '\n```')).toEqual(good);
    expect(parseExtraction('{"gaps":[]}')).toEqual({ gaps: [] });
  });

  it('rejects unknown topics, targets, and missing fields', () => {
    const bad = (patch: Record<string, unknown>) =>
      JSON.stringify({ gaps: [{ ...good.gaps[0], ...patch }] });
    expect(() => parseExtraction(bad({ topic: 'dinero' }))).toThrow();
    expect(() => parseExtraction(bad({ target: 'db' }))).toThrow();
    expect(() => parseExtraction(bad({ already_in_config: 'no' }))).toThrow();
    expect(() => parseExtraction(bad({ question: '' }))).toThrow();
    expect(() => parseExtraction('not json')).toThrow();
    expect(() => parseExtraction('{"items":[]}')).toThrow();
  });
});
