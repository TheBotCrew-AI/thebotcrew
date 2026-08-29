import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { TenantContext } from '../core/types.js';

vi.mock('../db/queries.js');

import * as q from '../db/queries.js';
import { queueCapiEvent, queueCapiStatusEvent, sendCapiEvent } from './capi.js';

const wa = { channel: 'whatsapp' as const, key: 'Afj1' };
const tenant = (metaCapi: TenantContext['metaCapi'] = { datasetId: 'ds1', pageId: 'pg1', tokenRef: 'MADI' }): TenantContext =>
  ({ tenantId: 't1', clientId: 'client1', metaCapi }) as TenantContext;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(q.enqueueCapiEvent).mockResolvedValue(true);
  vi.mocked(q.getConversationCapiIdentity).mockResolvedValue(null);
});

describe('queueCapiEvent — gates', () => {
  it('no metaCapi config → no-op, no DB reads', async () => {
    await queueCapiEvent({ tenant: tenant(null), ghlConversationId: 'conv1', kind: 'lead_started', identity: wa });
    expect(q.enqueueCapiEvent).not.toHaveBeenCalled();
    expect(q.getConversationCapiIdentity).not.toHaveBeenCalled();
  });

  it('kind disabled by config → no-op', async () => {
    const t = tenant({ datasetId: 'ds1', pageId: 'pg1', tokenRef: 'MADI', events: { lead_started: false } });
    await queueCapiEvent({ tenant: t, ghlConversationId: 'conv1', kind: 'lead_started', identity: wa });
    expect(q.enqueueCapiEvent).not.toHaveBeenCalled();
  });

  it('no identity passed AND none stored → no event (a WhatsApp lead not from a CTWA ad)', async () => {
    await queueCapiEvent({ tenant: tenant(), ghlConversationId: 'conv1', kind: 'appointment_booked' });
    expect(q.getConversationCapiIdentity).toHaveBeenCalledWith('conv1');
    expect(q.enqueueCapiEvent).not.toHaveBeenCalled();
  });

  it('excluded phone passed by the hook → no event', async () => {
    const t = tenant({ datasetId: 'ds1', pageId: 'pg1', tokenRef: 'MADI', excludePhones: ['526643850341'] });
    await queueCapiEvent({ tenant: t, ghlConversationId: 'conv1', kind: 'lead_started', identity: wa, phone: '+5216643850341' });
    expect(q.enqueueCapiEvent).not.toHaveBeenCalled();
    expect(q.getConversationContactKeys).not.toHaveBeenCalled();
  });

  it('excluded phone read from the conversation when the hook passed none (status path) → no event', async () => {
    const t = tenant({ datasetId: 'ds1', pageId: 'pg1', tokenRef: 'MADI', excludePhones: ['526643850341'] });
    vi.mocked(q.getConversationContactKeys).mockResolvedValue({ phone: '+526643850341', email: null });
    await queueCapiEvent({ tenant: t, ghlConversationId: 'conv1', kind: 'appointment_booked', identity: wa });
    expect(q.getConversationContactKeys).toHaveBeenCalledWith('conv1');
    expect(q.enqueueCapiEvent).not.toHaveBeenCalled();
  });

  it('a phone NOT on the list still enqueues; no list → the conversation is never read for it', async () => {
    const t = tenant({ datasetId: 'ds1', pageId: 'pg1', tokenRef: 'MADI', excludePhones: ['526643850341'] });
    await queueCapiEvent({ tenant: t, ghlConversationId: 'conv1', kind: 'lead_started', identity: wa, phone: '+5215512345678' });
    expect(q.enqueueCapiEvent).toHaveBeenCalledTimes(1);
    vi.clearAllMocks();
    vi.mocked(q.enqueueCapiEvent).mockResolvedValue(true);
    await queueCapiEvent({ tenant: tenant(), ghlConversationId: 'conv1', kind: 'lead_started', identity: wa });
    expect(q.getConversationContactKeys).not.toHaveBeenCalled();
    expect(q.enqueueCapiEvent).toHaveBeenCalledTimes(1);
  });

  it('never throws — a DB failure is swallowed', async () => {
    vi.mocked(q.enqueueCapiEvent).mockRejectedValue(new Error('db down'));
    await expect(
      queueCapiEvent({ tenant: tenant(), ghlConversationId: 'conv1', kind: 'lead_started', identity: wa }),
    ).resolves.toBeUndefined();
  });
});

describe('queueCapiEvent — enqueue', () => {
  it('freezes the payload (channel included) and uses the conversation:kind event id', async () => {
    await queueCapiEvent({
      tenant: tenant(),
      ghlConversationId: 'conv1',
      kind: 'lead_started',
      identity: wa,
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
          messaging_channel: 'whatsapp',
          user_data: expect.objectContaining({ ctwa_clid: 'Afj1', page_id: 'pg1', ph: [expect.any(String)] }),
        }),
      }),
    );
  });

  it('reads the stored identity when the caller has none (booking hook path)', async () => {
    vi.mocked(q.getConversationCapiIdentity).mockResolvedValue({ channel: 'whatsapp', key: 'Afj-stored' });
    await queueCapiEvent({ tenant: tenant(), ghlConversationId: 'conv1', kind: 'appointment_booked' });
    expect(q.enqueueCapiEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        p_event_name: 'QualifiedLead', // booking default: qualified lead, not Purchase
        p_payload: expect.objectContaining({ user_data: expect.objectContaining({ ctwa_clid: 'Afj-stored' }) }),
      }),
    );
  });

  it('a Facebook lead (0056) queues a messenger event keyed on the PSID — same event id scheme', async () => {
    await queueCapiEvent({
      tenant: tenant(),
      ghlConversationId: 'conv-fb',
      kind: 'lead_started',
      identity: { channel: 'messenger', key: '36250000000000034' },
    });
    expect(q.enqueueCapiEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        p_event_id: 'conv-fb:lead_started',
        p_payload: {
          messaging_channel: 'messenger',
          user_data: { page_scoped_user_id: '36250000000000034', page_id: 'pg1' },
        },
      }),
    );
  });

  it('an Instagram lead with no instagram_business_account_id configured is skipped, loudly, never thrown', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await queueCapiEvent({
      tenant: tenant(),
      ghlConversationId: 'conv-ig',
      kind: 'lead_started',
      identity: { channel: 'instagram', key: '1383000000000020' },
    });
    expect(q.enqueueCapiEvent).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('instagram lead but meta_capi lacks the account id'));
    warn.mockRestore();

    await queueCapiEvent({
      tenant: tenant({ datasetId: 'ds1', pageId: 'pg1', tokenRef: 'MADI', instagramBusinessAccountId: '1784' }),
      ghlConversationId: 'conv-ig',
      kind: 'lead_started',
      identity: { channel: 'instagram', key: '1383000000000020' },
    });
    expect(q.enqueueCapiEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        p_payload: { messaging_channel: 'instagram', user_data: { ig_sid: '1383000000000020', ig_account_id: '1784' } },
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
    await queueCapiEvent({ tenant: t, ghlConversationId: 'conv1', kind: 'appointment_booked', identity: wa });
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
    vi.mocked(q.getConversationCapiIdentity).mockResolvedValue(wa);
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
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('{"events_received":1,"messages":[],"fbtrace_id":"x"}', { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const res = await sendCapiEvent({ datasetId: 'ds1', token: 'tok', testEventCode: 'TEST9', event });
    expect(res).toEqual({ ok: true, eventsReceived: 1 }); // empty messages[] is dropped
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
