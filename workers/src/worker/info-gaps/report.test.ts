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
  configChangedAt: null,
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
      closedAfterAsked: 0,
      carriedOpen: 1,
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
    // A gap this run did not touch is carry-over: section 5, not 1–3.
    const s5 = markdown.indexOf('## 5.');
    expect(markdown.slice(s1, s5)).not.toContain('no tocado en esta corrida');
    expect(markdown.slice(s5)).toContain('**no tocado en esta corrida** · 9×');
    expect(markdown.slice(s5)).toContain('el equipo ya lo contestó');
  });

  it('says so when a section is empty instead of leaving it blank', () => {
    const { markdown } = buildReport({ ...base, gaps: [], touched: new Set() });
    expect(markdown.match(/_Nada nuevo en esta ventana\._/g)).toHaveLength(2);
    expect(markdown).toContain('_Ninguno._');
    expect(markdown).toContain('tuvo respuesta humana');
    expect(markdown).toContain('todo lo abierto se preguntó en esta ventana');
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

describe('buildReport — a fact loaded AFTER the lead asked is not a prompt bug', () => {
  // The first MADI run compared July conversations against the config as it stood on
  // 2026-08-25, after 14 gaps had been loaded that afternoon: 47 topics came out as
  // "the bot had it and did not use it". The config change time splits them.
  const gaps: ReportGap[] = [
    g({ topicKey: 'formas_pago:pago-sesion', topicLabel: 'pago por sesión', target: 'prompt_bug', occurrences: 8, lastSeen: '2026-08-24T00:00:00Z' }),
    g({ topicKey: 'ubicacion:mapa', topic: 'ubicacion', topicLabel: 'mapa', target: 'prompt_bug', occurrences: 2, lastSeen: '2026-08-26T10:00:00Z' }),
  ];
  const touched = new Set(['formas_pago:pago-sesion', 'ubicacion:mapa']);

  it('files pre-change topics under 3b and keeps only post-change ones as bugs', () => {
    const { markdown, summary } = buildReport({ ...base, gaps, touched, configChangedAt: '2026-08-25T18:00:00Z' });
    expect(summary).toMatchObject({ promptBugs: 1, closedAfterAsked: 1 });
    const s3 = markdown.indexOf('## 3.');
    const s3b = markdown.indexOf('## 3b.');
    const s4 = markdown.indexOf('## 4.');
    expect(s3b).toBeGreaterThan(s3);
    expect(markdown.slice(s3, s3b)).toContain('### mapa');
    expect(markdown.slice(s3, s3b)).not.toContain('pago por sesión');
    expect(markdown.slice(s3b, s4)).toContain('pago por sesión · 8×');
    expect(markdown.slice(s3b, s4)).toContain('2026-08-25');
  });

  it('with no history, every already_in_config gap counts as a bug and 3b is absent', () => {
    const { markdown, summary } = buildReport({ ...base, gaps, touched, configChangedAt: null });
    expect(summary).toMatchObject({ promptBugs: 2, closedAfterAsked: 0 });
    expect(markdown).not.toContain('## 3b.');
  });
});

describe('buildReport — section 5 does not resurrect "loaded after asked" leftovers', () => {
  it('excludes open prompt_bug gaps that predate the config change, and target none', () => {
    const gaps: ReportGap[] = [
      g({ topicKey: 'a', topicLabel: 'viejo bug aparente', target: 'prompt_bug', lastSeen: '2026-08-20T00:00:00Z' }),
      g({ topicKey: 'b', topicLabel: 'queja', target: 'none' }),
      g({ topicKey: 'c', topicLabel: 'edad mínima', topic: 'edad', target: 'faq', occurrences: 2 }),
    ];
    const { markdown, summary } = buildReport({ ...base, gaps, touched: new Set(), configChangedAt: '2026-08-25T18:00:00Z' });
    expect(summary.carriedOpen).toBe(1);
    const s5 = markdown.slice(markdown.indexOf('## 5.'));
    expect(s5).toContain('**edad mínima**');
    expect(s5).not.toContain('viejo bug aparente');
    expect(s5).not.toContain('queja');
  });
});
