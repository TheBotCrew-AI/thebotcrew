import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../db/queries.js');
vi.mock('../meta/capi.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../meta/capi.js')>()),
  sendCapiEvent: vi.fn(),
}));

import * as q from '../db/queries.js';
import { sendCapiEvent } from '../meta/capi.js';
import { runPendingCapiEvents } from './capi-runner.js';

type Pending = Awaited<ReturnType<typeof q.loadPendingCapiEvents>>[number];
const row = (o: Partial<Pending> = {}): Pending => ({
  id: 'row1',
  clientId: 'client1',
  ghlConversationId: 'conv1',
  kind: 'lead_started',
  eventName: 'LeadSubmitted',
  eventId: 'conv1:lead_started',
  eventTime: new Date('2026-08-01T18:00:00Z').toISOString(),
  payload: { user_data: { ctwa_clid: 'Afj1', page_id: 'pg1' } },
  attempts: 0,
  lastError: null,
  createdAt: new Date().toISOString(),
  tenantId: 't1',
  metaCapi: { dataset_id: 'ds1', page_id: 'pg1', token_ref: 'MADI' },
  ...o,
});

beforeEach(() => {
  vi.clearAllMocks();
  process.env.META_CAPI_TOKEN__MADI = 'EAAG-token';
  vi.mocked(q.loadPendingCapiEvents).mockResolvedValue([row()]);
  vi.mocked(q.markCapiEvent).mockResolvedValue(undefined);
  vi.mocked(q.incrementCapiAttempts).mockResolvedValue(undefined);
  vi.mocked(q.logBotEvent).mockResolvedValue(undefined);
  vi.mocked(sendCapiEvent).mockResolvedValue({ ok: true });
});

afterEach(() => {
  delete process.env.META_CAPI_TOKEN__MADI;
});

describe('runPendingCapiEvents — happy path', () => {
  it('a row frozen with a channel (0056) is sent on that channel, user_data untouched', async () => {
    vi.mocked(q.loadPendingCapiEvents).mockResolvedValue([
      row({
        eventId: 'conv-fb:lead_started',
        payload: { messaging_channel: 'messenger', user_data: { page_scoped_user_id: '3625', page_id: 'pg1' } },
      }),
    ]);
    await runPendingCapiEvents();
    expect(sendCapiEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          messaging_channel: 'messenger',
          user_data: { page_scoped_user_id: '3625', page_id: 'pg1' },
        }),
      }),
    );
  });

  it('sends with the fresh config, marks sent, logs capi_event_sent (a pre-0056 row = whatsapp)', async () => {
    const res = await runPendingCapiEvents();
    expect(q.incrementCapiAttempts).toHaveBeenCalledWith('row1');
    expect(sendCapiEvent).toHaveBeenCalledWith({
      datasetId: 'ds1',
      token: 'EAAG-token',
      testEventCode: undefined,
      event: {
        event_name: 'LeadSubmitted',
        event_time: Math.floor(new Date('2026-08-01T18:00:00Z').getTime() / 1000),
        event_id: 'conv1:lead_started',
        action_source: 'business_messaging',
        messaging_channel: 'whatsapp',
        user_data: { ctwa_clid: 'Afj1', page_id: 'pg1' },
      },
    });
    expect(q.markCapiEvent).toHaveBeenCalledWith('row1', 'sent');
    expect(q.logBotEvent).toHaveBeenCalledWith('client1', 'conv1', 'capi_event_sent', {
      kind: 'lead_started',
      eventName: 'LeadSubmitted',
      eventId: 'conv1:lead_started',
    });
    expect(res).toEqual({ tried: 1, sent: 1, failed: 0, skipped: 0 });
  });

  it('passes test_event_code through from the LIVE config (re-read each drain)', async () => {
    vi.mocked(q.loadPendingCapiEvents).mockResolvedValue([
      row({ metaCapi: { dataset_id: 'ds1', page_id: 'pg1', token_ref: 'MADI', test_event_code: 'TEST9' } }),
    ]);
    await runPendingCapiEvents();
    expect(sendCapiEvent).toHaveBeenCalledWith(expect.objectContaining({ testEventCode: 'TEST9' }));
    expect(q.logBotEvent).toHaveBeenCalledWith('client1', 'conv1', 'capi_event_sent', expect.objectContaining({ testEventCode: 'TEST9' }));
  });

  it('custom_data rides along when the payload froze one', async () => {
    vi.mocked(q.loadPendingCapiEvents).mockResolvedValue([
      row({ payload: { user_data: { ctwa_clid: 'a', page_id: 'p' }, custom_data: { value: 350, currency: 'MXN' } } }),
    ]);
    await runPendingCapiEvents();
    expect(sendCapiEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event: expect.objectContaining({ custom_data: { value: 350, currency: 'MXN' } }) }),
    );
  });
});

describe('runPendingCapiEvents — missing token secret (deliberate divergence from delivery-retry)', () => {
  beforeEach(() => {
    delete process.env.META_CAPI_TOKEN__MADI;
  });

  it('row stays pending, attempts NOT consumed, capi_error logged, parked with sentinel', async () => {
    const res = await runPendingCapiEvents();
    expect(q.incrementCapiAttempts).not.toHaveBeenCalled();
    expect(sendCapiEvent).not.toHaveBeenCalled();
    expect(q.markCapiEvent).toHaveBeenCalledWith('row1', 'pending', 'missing_token_secret');
    expect(q.logBotEvent).toHaveBeenCalledWith('client1', 'conv1', 'capi_error', {
      stage: 'missing_token_secret',
      tokenRef: 'MADI',
      kind: 'lead_started',
    });
    expect(res).toEqual({ tried: 1, sent: 0, failed: 0, skipped: 1 });
  });

  it('logs only once — a row already parked with the sentinel stays quiet', async () => {
    vi.mocked(q.loadPendingCapiEvents).mockResolvedValue([row({ lastError: 'missing_token_secret' })]);
    await runPendingCapiEvents();
    expect(q.logBotEvent).not.toHaveBeenCalled();
    expect(q.markCapiEvent).not.toHaveBeenCalled();
  });

  it('self-heals: once the secret lands the same row sends', async () => {
    process.env.META_CAPI_TOKEN__MADI = 'EAAG-token';
    vi.mocked(q.loadPendingCapiEvents).mockResolvedValue([row({ lastError: 'missing_token_secret' })]);
    const res = await runPendingCapiEvents();
    expect(q.markCapiEvent).toHaveBeenCalledWith('row1', 'sent');
    expect(res.sent).toBe(1);
  });
});

describe('runPendingCapiEvents — failure handling', () => {
  it('config deleted since enqueue → failed immediately', async () => {
    vi.mocked(q.loadPendingCapiEvents).mockResolvedValue([row({ metaCapi: null })]);
    const res = await runPendingCapiEvents();
    expect(q.markCapiEvent).toHaveBeenCalledWith('row1', 'failed', 'tenant_capi_config_missing');
    expect(q.logBotEvent).toHaveBeenCalledWith('client1', 'conv1', 'capi_error', expect.objectContaining({ stage: 'config_missing' }));
    expect(res.failed).toBe(1);
  });

  it('row older than 48h → expired (the click id has decayed anyway)', async () => {
    vi.mocked(q.loadPendingCapiEvents).mockResolvedValue([
      row({ createdAt: new Date(Date.now() - 49 * 60 * 60 * 1000).toISOString() }),
    ]);
    const res = await runPendingCapiEvents();
    expect(sendCapiEvent).not.toHaveBeenCalled();
    expect(q.markCapiEvent).toHaveBeenCalledWith('row1', 'failed', 'expired');
    expect(q.logBotEvent).toHaveBeenCalledWith('client1', 'conv1', 'capi_error', expect.objectContaining({ stage: 'expired' }));
    expect(res.failed).toBe(1);
  });

  it('terminal 4xx → failed on the first attempt (retrying the same bytes cannot win)', async () => {
    vi.mocked(sendCapiEvent).mockResolvedValue({ ok: false, retryable: false, error: 'graph 400: bad param' });
    const res = await runPendingCapiEvents();
    expect(q.markCapiEvent).toHaveBeenCalledWith('row1', 'failed', 'graph 400: bad param');
    expect(q.logBotEvent).toHaveBeenCalledWith('client1', 'conv1', 'capi_error', expect.objectContaining({ stage: 'rejected' }));
    expect(res.failed).toBe(1);
  });

  it('retryable 5xx with attempts left → parked pending with the error', async () => {
    vi.mocked(sendCapiEvent).mockResolvedValue({ ok: false, retryable: true, error: 'graph 503: oops' });
    const res = await runPendingCapiEvents();
    expect(q.markCapiEvent).toHaveBeenCalledWith('row1', 'pending', 'graph 503: oops');
    expect(res).toEqual({ tried: 1, sent: 0, failed: 0, skipped: 0 });
  });

  it('retryable failure on the 3rd attempt → failed (mirrors delivery-retry cap)', async () => {
    vi.mocked(q.loadPendingCapiEvents).mockResolvedValue([row({ attempts: 2 })]);
    vi.mocked(sendCapiEvent).mockResolvedValue({ ok: false, retryable: true, error: 'graph 503: oops' });
    const res = await runPendingCapiEvents();
    expect(q.markCapiEvent).toHaveBeenCalledWith('row1', 'failed', 'graph 503: oops');
    expect(q.logBotEvent).toHaveBeenCalledWith('client1', 'conv1', 'capi_error', expect.objectContaining({ stage: 'retries_exhausted' }));
    expect(res.failed).toBe(1);
  });
});
