import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db/queries.js');
vi.mock('./aux-llm.js', () => ({ auxJsonCompletion: vi.fn() }));
const addContactTags = vi.fn();
vi.mock('../ghl/client.js', () => ({
  GhlClient: vi.fn(() => ({ addContactTags })),
}));

import * as q from '../db/queries.js';
import { auxJsonCompletion } from './aux-llm.js';
import { runInfoGapExtractions, runPendingInfoAlerts } from './info-gap-runner.js';
import type { TenantContext } from '../core/types.js';

const NOW = new Date('2026-08-25T13:00:00Z');

const tenant = (): TenantContext => ({
  tenantId: 't1',
  clientId: 'c1',
  ghlLocationId: 'loc1',
  enabledRoles: ['front-desk'],
  enabledChannels: ['whatsapp'],
  testContactIds: null,
  triggerKeywords: null,
  demoOnKeywords: null,
  demoOffKeywords: null,
  keywordVariants: null,
  awaitingHumanTag: null,
  pendingInfoTag: 'dato-pendiente',
  demoSessionsEnabled: false,
  metaCapi: null,
  config: {
    businessName: 'MADI Skin Care',
    timezone: 'America/Tijuana',
    tone: null,
    services: [],
    hours: { mon: [{ open: '08:00', close: '19:00' }] },
    calendars: {},
    faq: [{ q: '¿Dónde?', a: 'Plaza Financiera' }],
    promptOverrides: { offering: 'Axilas: $2,300' },
    demoPromptOverrides: null,
    promptVariants: null,
    provider: undefined,
    model: undefined,
    followUpCadence: null,
    followUpAngles: null,
    followUpRounds: null,
    quietHours: null,
    bookingHorizonDays: null,
    humanPauseMinutes: null,
    aiKeyRef: null,
  },
});

const goodResult = {
  gaps: [{
    question: '¿se paga todo junto?',
    topic: 'formas_pago',
    topic_label: 'pago por sesion',
    human_answer: 'Completo en la primera sesión',
    already_in_config: false,
    target: 'offering',
    suggested_text: 'Se paga completo en la primera sesión.',
  }],
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env.OPENAI_API_KEY = 'sk-test';
  vi.mocked(q.loadInfoGapTenants).mockResolvedValue([]);
  vi.mocked(q.claimInfoGapExtractions).mockResolvedValue([]);
  vi.mocked(q.loadFinalizableInfoGapRuns).mockResolvedValue([]);
  vi.mocked(q.getTenantGhlLocationId).mockResolvedValue('loc1');
  vi.mocked(q.loadTenantConfig).mockResolvedValue(tenant());
  vi.mocked(q.completeInfoGapExtraction).mockResolvedValue(undefined);
  vi.mocked(q.logBotEvent).mockResolvedValue(undefined);
  vi.mocked(q.openInfoGapRun).mockResolvedValue('run-1');
  vi.mocked(q.upsertInfoGap).mockResolvedValue('open');
  vi.mocked(q.loadInfoGaps).mockResolvedValue([]);
  vi.mocked(q.saveInfoGapReport).mockResolvedValue(undefined);
  vi.mocked(q.finishInfoGapRun).mockResolvedValue(undefined);
  vi.mocked(q.loadUnansweredPendingInfo).mockResolvedValue([]);
  vi.mocked(q.loadTenantConfigLastChange).mockResolvedValue(null);
});

describe('runInfoGapExtractions — opening runs', () => {
  const tenantRow = (o: Partial<Awaited<ReturnType<typeof q.loadInfoGapTenants>>[number]> = {}) => ({
    tenantId: 't1',
    clientId: 'c1',
    ghlLocationId: 'loc1',
    infoGaps: { enabled: true, min_candidates: 10, max_days: 7, min_for_time_run: 3 },
    lastWindowTo: null,
    lastStartedAt: null,
    hasOpenRun: false,
    ...o,
  });

  it('opens a run over the last 30 days for a tenant that never ran and has enough candidates', async () => {
    vi.mocked(q.loadInfoGapTenants).mockResolvedValue([tenantRow()]);
    vi.mocked(q.countInfoGapCandidates).mockResolvedValue(12);
    const res = await runInfoGapExtractions(NOW);
    expect(res.runsOpened).toBe(1);
    const [, , from, to] = vi.mocked(q.openInfoGapRun).mock.calls[0]!;
    expect(to).toBe(NOW.toISOString());
    expect(new Date(from).getTime()).toBe(NOW.getTime() - 30 * 86_400_000);
  });

  it('starts the next window where the last one ended', async () => {
    vi.mocked(q.loadInfoGapTenants).mockResolvedValue([
      tenantRow({ lastWindowTo: '2026-08-18T13:00:00Z', lastStartedAt: '2026-08-18T13:00:00Z' }),
    ]);
    vi.mocked(q.countInfoGapCandidates).mockResolvedValue(3);
    await runInfoGapExtractions(NOW);
    expect(q.countInfoGapCandidates).toHaveBeenCalledWith('c1', '2026-08-18T13:00:00.000Z', NOW.toISOString());
    expect(q.openInfoGapRun).toHaveBeenCalledWith('t1', 'c1', '2026-08-18T13:00:00.000Z', NOW.toISOString());
  });

  it('does not open when one is already open, when not due, or when the config is off', async () => {
    vi.mocked(q.countInfoGapCandidates).mockResolvedValue(50);
    vi.mocked(q.loadInfoGapTenants).mockResolvedValue([tenantRow({ hasOpenRun: true })]);
    expect((await runInfoGapExtractions(NOW)).runsOpened).toBe(0);

    vi.mocked(q.loadInfoGapTenants).mockResolvedValue([tenantRow({ infoGaps: { enabled: false } })]);
    expect((await runInfoGapExtractions(NOW)).runsOpened).toBe(0);

    vi.mocked(q.countInfoGapCandidates).mockResolvedValue(2);
    vi.mocked(q.loadInfoGapTenants).mockResolvedValue([tenantRow()]);
    expect((await runInfoGapExtractions(NOW)).runsOpened).toBe(0);
    expect(q.openInfoGapRun).not.toHaveBeenCalled();
  });
});

describe('runInfoGapExtractions — draining', () => {
  const claimed = (attempts = 1) => ({
    id: 'x1',
    runId: 'run-1',
    tenantId: 't1',
    clientId: 'c1',
    conversationId: 'conv-uuid',
    ghlConversationId: 'ghl-conv',
    reasons: ['pending_info', 'human_reply'],
    attempts,
  });

  beforeEach(() => {
    vi.mocked(q.loadRecentMessages).mockResolvedValue([
      { direction: 'inbound', senderType: 'lead', content: '¿se paga todo junto?', sentAt: '2026-08-10T23:16:00Z' },
      { direction: 'outbound', senderType: 'bot', content: 'Lo confirmo con el equipo.', sentAt: '2026-08-10T23:16:30Z' },
      { direction: 'outbound', senderType: 'human_agent', content: 'Completo en la primera sesión', sentAt: '2026-08-10T23:35:00Z' },
    ]);
  });

  it('sends the transcript with the tenant\'s current knowledge and stores the parsed result', async () => {
    vi.mocked(q.claimInfoGapExtractions).mockResolvedValue([claimed()]);
    vi.mocked(auxJsonCompletion).mockResolvedValue(JSON.stringify(goodResult));

    const res = await runInfoGapExtractions(NOW);

    expect(res).toMatchObject({ claimed: 1, extracted: 1, failed: 0 });
    const [prompt, llm, kind, budget] = vi.mocked(auxJsonCompletion).mock.calls[0]!;
    expect(prompt).toContain('[HUMANO] Completo en la primera sesión');
    expect(prompt).toContain('Axilas: $2,300');
    expect(prompt).toContain('P: ¿Dónde?');
    expect(prompt).toContain('Lunes: 08:00–19:00');
    expect(llm).toMatchObject({ clientId: 'c1', ghlConversationId: 'ghl-conv', provider: 'openai', keySource: 'platform' });
    expect(kind).toBe('info_gap_extract');
    expect(budget).toBe(2_000);
    expect(q.completeInfoGapExtraction).toHaveBeenCalledWith('x1', 'done', goodResult);
  });

  it('puts an unparseable answer back for a retry, and fails it for good on the third attempt', async () => {
    vi.mocked(q.claimInfoGapExtractions).mockResolvedValue([claimed(1)]);
    vi.mocked(auxJsonCompletion).mockResolvedValue('{"gaps":[{"topic":"dinero"}]}');
    let res = await runInfoGapExtractions(NOW);
    expect(res.failed).toBe(0);
    expect(q.completeInfoGapExtraction).toHaveBeenCalledWith('x1', 'pending', null, expect.any(String));
    expect(q.logBotEvent).not.toHaveBeenCalled();

    vi.clearAllMocks();
    vi.mocked(q.loadFinalizableInfoGapRuns).mockResolvedValue([]);
    vi.mocked(q.claimInfoGapExtractions).mockResolvedValue([claimed(3)]);
    vi.mocked(auxJsonCompletion).mockRejectedValue(new Error('openai info_gap_extract 500'));
    res = await runInfoGapExtractions(NOW);
    expect(res.failed).toBe(1);
    expect(q.completeInfoGapExtraction).toHaveBeenCalledWith('x1', 'failed', null, 'openai info_gap_extract 500');
    expect(q.logBotEvent).toHaveBeenCalledWith('c1', 'ghl-conv', 'info_gap_error', expect.objectContaining({ stage: 'extract' }));
  });

  it('fails a row whose tenant no longer resolves without calling the model', async () => {
    vi.mocked(q.claimInfoGapExtractions).mockResolvedValue([claimed()]);
    vi.mocked(q.getTenantGhlLocationId).mockResolvedValue(undefined);
    const res = await runInfoGapExtractions(NOW);
    expect(res.failed).toBe(1);
    expect(auxJsonCompletion).not.toHaveBeenCalled();
    expect(q.completeInfoGapExtraction).toHaveBeenCalledWith('x1', 'failed', null, 'tenant_missing');
  });
});

describe('runInfoGapExtractions — finalizing', () => {
  const run = { id: 'run-1', tenantId: 't1', clientId: 'c1', windowFrom: '2026-07-29T00:00:00Z', windowTo: '2026-08-25T00:00:00Z', candidates: 3 };

  it('upserts each (conversation, topic) once, writes the report, closes the run', async () => {
    vi.mocked(q.loadFinalizableInfoGapRuns).mockResolvedValue([run]);
    vi.mocked(q.loadInfoGapExtractions).mockResolvedValue([
      { conversationId: 'a', reasons: ['human_reply'], status: 'done', result: goodResult, lastMessageAt: '2026-08-10T00:00:00Z' },
      { conversationId: 'b', reasons: ['pending_info'], status: 'done', result: { gaps: [{ ...goodResult.gaps[0], human_answer: null, suggested_text: null }] }, lastMessageAt: '2026-08-19T00:00:00Z' },
      { conversationId: 'c', reasons: ['pending_info'], status: 'failed', result: null, lastMessageAt: null },
    ]);
    vi.mocked(q.loadInfoGaps).mockResolvedValue([{
      topicKey: 'formas_pago:pago-sesion', topic: 'formas_pago', topicLabel: 'pago por sesion', status: 'open', target: 'offering',
      occurrences: 2, questionExamples: ['¿se paga todo junto?'], humanAnswers: ['Completo en la primera sesión'],
      suggestedText: 'Se paga completo en la primera sesión.', firstSeen: '2026-08-10T00:00:00Z', lastSeen: '2026-08-19T00:00:00Z',
    }]);

    const res = await runInfoGapExtractions(NOW);

    expect(res.runsFinished).toBe(1);
    expect(q.upsertInfoGap).toHaveBeenCalledTimes(2);
    expect(q.upsertInfoGap).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 't1', topicKey: 'formas_pago:pago-sesion', humanAnswer: 'Completo en la primera sesión', seenAt: '2026-08-10T00:00:00Z',
    }));
    const [runId, tenantId, markdown, summary] = vi.mocked(q.saveInfoGapReport).mock.calls[0]!;
    expect(runId).toBe('run-1');
    expect(tenantId).toBe('t1');
    expect(markdown).toContain('# MADI Skin Care — huecos de información');
    expect(markdown).toContain('pago por sesion');
    // conversations b and c: a pending_info nobody answered → the lost-lead list.
    // c's extraction failed, but the thread is still a lead nobody replied to.
    expect(markdown).toContain('## 4. Sin respuesta de nadie');
    expect(markdown).toMatch(/2026-08-19 · `b`/);
    expect(markdown).toMatch(/— · `c`/);
    expect(summary).toMatchObject({ readyToLoad: 1, unanswered: 2, extracted: 2, failed: 1, candidates: 3 });
    expect(q.loadTenantConfigLastChange).toHaveBeenCalledWith('t1');
    expect(q.finishInfoGapRun).toHaveBeenCalledWith('run-1', 'done', 2, 1);
  });

  it('marks the run failed instead of leaving it open forever when finalizing throws', async () => {
    vi.mocked(q.loadFinalizableInfoGapRuns).mockResolvedValue([run]);
    vi.mocked(q.loadInfoGapExtractions).mockRejectedValue(new Error('db down'));
    const res = await runInfoGapExtractions(NOW);
    expect(res.runsFinished).toBe(0);
    expect(q.finishInfoGapRun).toHaveBeenCalledWith('run-1', 'failed', 0, 0);
  });
});

describe('runPendingInfoAlerts', () => {
  const row = (o: Partial<Awaited<ReturnType<typeof q.loadUnansweredPendingInfo>>[number]> = {}) => ({
    tenantId: 't1',
    clientId: 'c1',
    conversationId: 'conv-uuid',
    ghlConversationId: 'ghl-conv',
    ghlContactId: 'contact-1',
    escalationTag: 'dato-sin-respuesta',
    question: '¿desde qué edad?',
    flaggedAt: '2026-08-19T23:25:00Z',
    ...o,
  });

  it('adds the escalation tag and records the event so the next day skips it', async () => {
    vi.mocked(q.loadUnansweredPendingInfo).mockResolvedValue([row()]);
    addContactTags.mockResolvedValue(undefined);
    const res = await runPendingInfoAlerts();
    expect(res).toEqual({ found: 1, escalated: 1, failed: 0 });
    expect(addContactTags).toHaveBeenCalledWith('contact-1', ['dato-sin-respuesta']);
    expect(q.logBotEvent).toHaveBeenCalledWith('c1', 'ghl-conv', 'pending_info_escalated', {
      tag: 'dato-sin-respuesta',
      question: '¿desde qué edad?',
      flaggedAt: '2026-08-19T23:25:00Z',
    });
  });

  it('logs a GHL failure as info_gap_error and keeps going — no escalated event, so it retries tomorrow', async () => {
    vi.mocked(q.loadUnansweredPendingInfo).mockResolvedValue([row(), row({ ghlContactId: 'contact-2', ghlConversationId: 'ghl-2' })]);
    addContactTags.mockRejectedValueOnce(new Error('[ghl] POST contact tags failed 401')).mockResolvedValueOnce(undefined);
    const res = await runPendingInfoAlerts();
    expect(res).toEqual({ found: 2, escalated: 1, failed: 1 });
    expect(q.logBotEvent).toHaveBeenCalledWith('c1', 'ghl-conv', 'info_gap_error', expect.objectContaining({ stage: 'escalation' }));
    expect(q.logBotEvent).toHaveBeenCalledWith('c1', 'ghl-2', 'pending_info_escalated', expect.anything());
  });
});
