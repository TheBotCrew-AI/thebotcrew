import { describe, it, expect } from 'vitest';
import { normalizeLabel, topicKey, toUpserts } from './aggregate.js';
import type { ExtractedGap } from './extract.js';

const gap = (o: Partial<ExtractedGap> = {}): ExtractedGap => ({
  question: '¿Cuánto sale axilas y piernas completas?',
  topic: 'precio',
  topic_label: 'axilas piernas completas',
  human_answer: null,
  already_in_config: false,
  target: 'offering',
  suggested_text: null,
  ...o,
});

describe('topicKey', () => {
  it('is order-, accent-, case- and stopword-insensitive', () => {
    expect(normalizeLabel('Precio de las Piernas Completas')).toEqual(['completas', 'piernas', 'precio']);
    expect(topicKey('precio', 'piernas completas y axilas')).toBe('precio:axilas-completas-piernas');
    expect(topicKey('precio', 'Axilas + Piernas completas')).toBe(topicKey('precio', 'piernas completas y axilas'));
    expect(topicKey('edad', 'edad mínima')).toBe(topicKey('edad', 'Edad minima'));
  });

  it('never collapses across topics, and has a fallback for an empty label', () => {
    expect(topicKey('precio', 'axilas')).not.toBe(topicKey('promocion', 'axilas'));
    expect(topicKey('otro', 'de la')).toBe('otro:general');
  });
});

describe('toUpserts', () => {
  it('counts a topic once per conversation, keeping the entry that has the human answer', () => {
    const out = toUpserts([
      {
        conversationId: 'c1',
        seenAt: '2026-08-10T00:00:00Z',
        result: {
          gaps: [
            gap({ question: '¿puedo pagar por sesiones?', topic: 'formas_pago', topic_label: 'pago por sesion' }),
            gap({
              question: 'primero quiero saber si se puede',
              topic: 'formas_pago',
              topic_label: 'Pago por sesión',
              human_answer: 'Por sesión son $500',
              suggested_text: 'Por sesión: $500.',
            }),
          ],
        },
      },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      topicKey: 'formas_pago:pago-sesion',
      humanAnswer: 'Por sesión son $500',
      suggestedText: 'Por sesión: $500.',
      conversationId: 'c1',
    });
  });

  it('keeps the same topic from two conversations as two occurrences', () => {
    const rec = (id: string) => ({ conversationId: id, seenAt: '2026-08-10T00:00:00Z', result: { gaps: [gap()] } });
    const out = toUpserts([rec('c1'), rec('c2')]);
    expect(out.map((u) => u.conversationId)).toEqual(['c1', 'c2']);
    expect(new Set(out.map((u) => u.topicKey)).size).toBe(1);
  });

  it('already_in_config overrides the target to prompt_bug and drops the suggestion', () => {
    const out = toUpserts([
      {
        conversationId: 'c1',
        seenAt: '2026-08-10T00:00:00Z',
        result: { gaps: [gap({ already_in_config: true, target: 'offering', suggested_text: 'no debería salir' })] },
      },
    ]);
    expect(out[0]).toMatchObject({ target: 'prompt_bug', suggestedText: null });
  });
});
