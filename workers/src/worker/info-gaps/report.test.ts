import { describe, it, expect } from 'vitest';
import { buildReport, type ReportGap } from './report.js';

const g = (o: Partial<ReportGap>): ReportGap => ({
  topicKey: 'precio:axilas-completas-piernas',
  topic: 'precio',
  topicLabel: 'axilas piernas completas',
  status: 'open',
  target: 'offering',
  occurrences: 3,
  questionExamples: ['¿cuánto sale axilas y piernas?'],
  humanAnswers: [],
  suggestedText: null,
  firstSeen: '2026-08-17T00:00:00Z',
  lastSeen: '2026-08-24T00:00:00Z',
  ...o,
});

const base = {
  businessName: 'MADI Skin Care',
  runId: 'run-1',
  windowFrom: '2026-07-29T00:00:00Z',
  windowTo: '2026-08-25T00:00:00Z',
  candidates: 34,
  extracted: 33,
  failed: 1,
  unanswered: [],
};

describe('buildReport', () => {
  it('files each gap under exactly one section and counts them in the summary', () => {
    const gaps: ReportGap[] = [
      g({ topicKey: 'formas_pago:pago-sesion', topicLabel: 'pago por sesión', occurrences: 10, humanAnswers: ['Completo en la primera sesión'], suggestedText: 'Se paga completo…' }),
      g({ topicKey: 'edad:edad-minima', topic: 'edad', topicLabel: 'edad mínima', occurrences: 2 }),
      g({ topicKey: 'ubicacion:mapa', topic: 'ubicacion', topicLabel: 'mapa', target: 'prompt_bug', occurrences: 1 }),
      g({ topicKey: 'precio:bikini', topicLabel: 'bikini', status: 'closed', occurrences: 4 }),
      g({ topicKey: 'precio:no-tocado', topicLabel: 'no tocado en esta corrida', occurrences: 9, humanAnswers: ['x'] }),
    ];
    const touched = new Set(['formas_pago:pago-sesion', 'edad:edad-minima', 'ubicacion:mapa', 'precio:bikini']);
    const { markdown, summary } = buildReport({ ...base, gaps, touched, unanswered: [{ conversationId: 'abcdef12-0000', question: '¿desde qué edad?', lastMessageAt: '2026-08-19T00:00:00Z' }] });

    expect(summary).toEqual({
      readyToLoad: 1,
      askClient: 1,
      promptBugs: 2,
      stillAskedAfterClose: 1,
      unanswered: 1,
      candidates: 34,
      extracted: 33,
      failed: 1,
    });

    const s1 = markdown.indexOf('## 1.');
    const s2 = markdown.indexOf('## 2.');
    const s3 = markdown.indexOf('## 3.');
    const s4 = markdown.indexOf('## 4.');
    const between = (a: number, b: number) => markdown.slice(a, b);
    expect(between(s1, s2)).toContain('pago por sesión');
    expect(between(s1, s2)).toContain('Texto propuesto');
    expect(between(s2, s3)).toContain('edad mínima');
    expect(between(s3, s4)).toContain('mapa');
    expect(between(s3, s4)).toContain('aún se pregunta');
    expect(markdown.slice(s4)).toContain('¿desde qué edad?');
    expect(markdown.slice(s4)).toContain('abcdef12');
    // A gap this run did not touch stays in the DB, not in the report.
    expect(markdown).not.toContain('no tocado en esta corrida');
  });

  it('says so when a section is empty instead of leaving it blank', () => {
    const { markdown } = buildReport({ ...base, gaps: [], touched: new Set() });
    expect(markdown.match(/_Nada nuevo en esta ventana\._/g)).toHaveLength(2);
    expect(markdown).toContain('_Ninguno._');
    expect(markdown).toContain('tuvo respuesta humana');
  });

  it('orders gaps by how often they were asked', () => {
    const gaps = [
      g({ topicKey: 'a', topicLabel: 'poco', occurrences: 1, humanAnswers: ['x'] }),
      g({ topicKey: 'b', topicLabel: 'mucho', occurrences: 7, humanAnswers: ['x'] }),
    ];
    const { markdown } = buildReport({ ...base, gaps, touched: new Set(['a', 'b']) });
    expect(markdown.indexOf('### mucho')).toBeLessThan(markdown.indexOf('### poco'));
  });
});
