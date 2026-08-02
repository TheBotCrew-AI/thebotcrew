import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { TenantContext } from '../core/types.js';

vi.mock('../db/queries.js');

import * as q from '../db/queries.js';
import { queueCapiEvent, queueCapiStatusEvent, sendCapiEvent } from './capi.js';

const tenant = (metaCapi: TenantContext['metaCapi'] = { datasetId: 'ds1', pageId: 'pg1', tokenRef: 'MADI' }): TenantContext =>
  ({ tenantId: 't1', clientId: 'client1', metaCapi }) as TenantContext;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(q.enqueueCapiEvent).mockResolvedValue(true);
  vi.mocked(q.getConversationCtwaClid).mockResolvedValue(null);
});

describe('queueCapiEvent — gates', () => {
  it('no metaCapi config → no-op, no DB reads', async () => {
    await queueCapiEvent({ tenant: tenant(null), ghlConversationId: 'conv1', kind: 'lead_started', ctwaClid: 'Afj1' });
    expect(q.enqueueCapiEvent).not.toHaveBeenCalled();
    expect(q.getConversationCtwaClid).not.toHaveBeenCalled();
  });

  it('kind disabled by config → no-op', async () => {
    const t = tenant({ datasetId: 'ds1', pageId: 'pg1', tokenRef: 'MADI', events: { lead_started: false } });
    await queueCapiEvent({ tenant: t, ghlConversationId: 'conv1', kind: 'lead_started', ctwaClid: 'Afj1' });
    expect(q.enqueueCapiEvent).not.toHaveBeenCalled();
  });

  it('no click id passed AND none stored → no event (lead not from a CTWA ad)', async () => {
    await queueCapiEvent({ tenant: tenant(), ghlConversationId: 'conv1', kind: 'appointment_booked' });
    expect(q.getConversationCtwaClid).toHaveBeenCalledWith('conv1');
    expect(q.enqueueCapiEvent).not.toHaveBeenCalled();
  });

  it('never throws — a DB failure is swallowed', async () => {
    vi.mocked(q.enqueueCapiEvent).mockRejectedValue(new Error('db down'));
    await expect(
      queueCapiEvent({ tenant: tenant(), ghlConversationId: 'conv1', kind: 'lead_started', ctwaClid: 'Afj1' }),
    ).resolves.toBeUndefined();
  });
});

describe('queueCapiEvent — enqueue', () => {
  it('freezes the payload and uses the conversation:kind event id', async () => {
    await queueCapiEvent({
      tenant: tenant(),
      ghlConversationId: 'conv1',
      kind: 'lead_started',
      ctwaClid: 'Afj1',
      phone: '+5216644045316',
    });
    expect(q.enqueueCapiEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        p_client_id: 'client1',
        p_ghl_conversation_id: 'conv1',
        p_kind: 'lead_started',
        p_event_name: 'LeadSubmitted',
        p_event_id: 'conv1:lead_started',
        p_payload: expect.objectContaining({
          user_data: expect.objectContaining({ ctwa_clid: 'Afj1', page_id: 'pg1', ph: [expect.any(String)] }),
        }),
      }),
    );
  });

  it('reads the stored click id when the caller has none (booking hook path)', async () => {
    vi.mocked(q.getConversationCtwaClid).mockResolvedValue('Afj-stored');
    await queueCapiEvent({ tenant: tenant(), ghlConversationId: 'conv1', kind: 'appointment_booked' });
    expect(q.enqueueCapiEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        p_event_name: 'QualifiedLead', // booking default: qualified lead, not Purchase
        p_payload: expect.objectContaining({ user_data: expect.objectContaining({ ctwa_clid: 'Afj-stored' }) }),
      }),
    );
  });

  it('a per-tenant override changes the event name and adds value', async () => {
    const t = tenant({
      datasetId: 'ds1',
      pageId: 'pg1',
      tokenRef: 'MADI',
      events: { appointment_booked: { name: 'Purchase', value: 350, currency: 'MXN' } },
    });
    await queueCapiEvent({ tenant: t, ghlConversationId: 'conv1', kind: 'appointment_booked', ctwaClid: 'Afj1' });
    expect(q.enqueueCapiEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        p_event_name: 'Purchase',
        p_payload: expect.objectContaining({ custom_data: { value: 350, currency: 'MXN' } }),
      }),
    );
  });
});

describe('queueCapiStatusEvent', () => {
  it('only `completed` signals, and only when the kind is configured (defaults off)', async () => {
    await queueCapiStatusEvent(tenant(), 'conv1', 'standby');
    await queueCapiStatusEvent(tenant(), 'conv1', 'opted_out');
    // completed but kind not opted in → still nothing
    await queueCapiStatusEvent(tenant(), 'conv1', 'completed');
    expect(q.enqueueCapiEvent).not.toHaveBeenCalled();

    const t = tenant({
      datasetId: 'ds1',
      pageId: 'pg1',
      tokenRef: 'MADI',
      events: { conversation_completed: { name: 'Purchase' } },
    });
    vi.mocked(q.getConversationCtwaClid).mockResolvedValue('Afj1');
    await queueCapiStatusEvent(t, 'conv1', 'completed');
    expect(q.enqueueCapiEvent).toHaveBeenCalledWith(
      expect.objectContaining({ p_kind: 'conversation_completed', p_event_name: 'Purchase' }),
    );
  });
});

describe('sendCapiEvent', () => {
  const event = {
    event_name: 'LeadSubmitted',
    event_time: 1_754_000_000,
    event_id: 'conv1:lead_started',
    action_source: 'business_messaging' as const,
    messaging_channel: 'whatsapp' as const,
    user_data: { ctwa_clid: 'Afj1', page_id: 'pg1' },
  };

  afterEach(() => vi.unstubAllGlobals());

  it('POSTs to the dataset with the token in the BODY (not the URL) and passes test_event_code', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await sendCapiEvent({ datasetId: 'ds1', token: 'tok', testEventCode: 'TEST9', event });
    expect(res).toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://graph.facebook.com/v23.0/ds1/events');
    expect(url).not.toContain('tok');
    const body = JSON.parse(init.body as string);
    expect(body.access_token).toBe('tok');
    expect(body.test_event_code).toBe('TEST9');
    expect(body.data).toEqual([event]);
  });

  it('4xx → terminal (retryable: false); 5xx → retryable; network error → retryable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('bad param', { status: 400 })));
    expect(await sendCapiEvent({ datasetId: 'ds1', token: 't', event })).toMatchObject({ ok: false, retryable: false });

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('oops', { status: 503 })));
    expect(await sendCapiEvent({ datasetId: 'ds1', token: 't', event })).toMatchObject({ ok: false, retryable: true });

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNRESET')));
    expect(await sendCapiEvent({ datasetId: 'ds1', token: 't', event })).toMatchObject({ ok: false, retryable: true });
  });
});
