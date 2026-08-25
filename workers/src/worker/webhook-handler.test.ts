import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Agent } from '@mastra/core/agent';
import type { TenantContext } from '../core/types.js';

// ── Mock the seams: DB, GHL transport, env. No DB, no network, no model. ──────
const ghl = {
  getContactPhone: vi.fn(),
  getContact: vi.fn(),
  updateContactName: vi.fn(),
  sendMessage: vi.fn(),
  addContactTags: vi.fn(),
};
vi.mock('../ghl/client.js', () => ({ GhlClient: vi.fn(() => ghl) }));
vi.mock('../core/env.js');
vi.mock('../db/queries.js');
vi.mock('../meta/capi.js');
// The predicate has its own unit tests (upcoming-appointment.test.ts); here it is a seam.
vi.mock('../db/upcoming-appointment.js', () => ({ findUpcomingAppointment: vi.fn() }));

import * as q from '../db/queries.js';
import { findUpcomingAppointment } from '../db/upcoming-appointment.js';
import { getAiApiKey, resolveAiApiKey } from '../core/env.js';
import { queueCapiEvent, queueCapiStatusEvent } from '../meta/capi.js';
import { handleInboundWebhook, runAgentTurn, splitIntoMessages } from './webhook-handler.js';

function tenant(overrides: Partial<TenantContext> = {}): TenantContext {
  return {
    tenantId: 't1',
    clientId: 'client1',
    ghlLocationId: 'loc1',
    enabledRoles: ['front-desk'],
    enabledChannels: ['whatsapp'],
    testContactIds: null,
    triggerKeywords: null,
    config: { businessName: 'Demo', timezone: 'America/Mexico_City', tone: null, services: [], hours: {}, calendars: {}, faq: {}, promptOverrides: {} },
    ...overrides,
  } as TenantContext;
}

const inbound = {
  type: 'InboundMessage',
  direction: 'inbound',
  locationId: 'loc1',
  contactId: 'c1',
  conversationId: 'conv1',
  body: 'hola',
  messageType: 'WhatsApp',
  phone: '+521',
};

/** Agent that replies with a question (so the classifier short-circuits, no fetch). */
function agentReplying(text = '¿En qué te puedo ayudar?'): Agent {
  return { generate: vi.fn().mockResolvedValue({ text, steps: [{ text }] }) } as unknown as Agent;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.mocked(getAiApiKey).mockReturnValue('test-key');
  vi.mocked(resolveAiApiKey).mockReturnValue({ apiKey: 'test-key', source: 'platform', fellBack: false });
  vi.mocked(q.loadTenantConfig).mockResolvedValue(tenant());
  vi.mocked(q.logMessage).mockResolvedValue({ conversationId: 'cv-uuid', messageId: 'msg-uuid' });
  vi.mocked(q.isBotSuppressed).mockResolvedValue(false);
  vi.mocked(q.isHumanActive).mockResolvedValue(false);
  vi.mocked(q.isLatestInboundMessage).mockResolvedValue(true);
  vi.mocked(q.loadRecentMessages).mockResolvedValue([]);
  vi.mocked(q.logBotEvent).mockResolvedValue(undefined);
  vi.mocked(q.cancelFollowUps).mockResolvedValue(undefined);
  vi.mocked(q.reactivateConversation).mockResolvedValue(undefined);
  vi.mocked(q.scheduleFollowUp).mockResolvedValue(null);
  vi.mocked(q.countSentDemoReminders).mockResolvedValue(0);
  vi.mocked(q.setGhlMessageId).mockResolvedValue(undefined);
  vi.mocked(q.markDelivered).mockResolvedValue(undefined);
  vi.mocked(q.updateConversationStatus).mockResolvedValue(true);
  vi.mocked(q.botActivation).mockResolvedValue('already');
  vi.mocked(q.findUnansweredInbound).mockResolvedValue(null);
  // Explicit default: clearAllMocks() does NOT drop implementations, so a test that
  // sets a demo persona would otherwise leak it into every later test.
  vi.mocked(q.getConversationPersona).mockResolvedValue({ activeRole: null, roleStartedAt: null, demoStartedAt: null, promptVariant: null, reactivationRound: 0 });
  vi.mocked(q.setConversationContactKeys).mockResolvedValue(undefined);
  vi.mocked(q.getConversationContactKeys).mockResolvedValue({ phone: null, email: null });
  vi.mocked(q.setConversationAttribution).mockResolvedValue(undefined);
  vi.mocked(q.updateConversationContact).mockResolvedValue(undefined);
  vi.mocked(findUpcomingAppointment).mockResolvedValue(null);
  ghl.getContactPhone.mockResolvedValue(undefined);
  ghl.getContact.mockResolvedValue(undefined);
  ghl.updateContactName.mockResolvedValue(undefined);
  ghl.sendMessage.mockResolvedValue({ ghlMessageId: 'out-ghl-1' });
  ghl.addContactTags.mockResolvedValue(undefined);
});

describe('splitIntoMessages', () => {
  it('keeps a single paragraph as one message', () => {
    expect(splitIntoMessages('Hola, ¿cómo estás?')).toEqual(['Hola, ¿cómo estás?']);
  });

  it('splits on blank-line paragraph breaks', () => {
    expect(splitIntoMessages('Primera idea.\n\nSegunda idea.')).toEqual(['Primera idea.', 'Segunda idea.']);
  });

  it('does NOT split single line breaks within a paragraph', () => {
    expect(splitIntoMessages('línea uno\nlínea dos')).toEqual(['línea uno\nlínea dos']);
  });

  it('trims parts and drops empty ones', () => {
    expect(splitIntoMessages('  uno  \n\n\n  dos  \n\n   ')).toEqual(['uno', 'dos']);
  });

  it('caps at 4 parts, merging the overflow into the last', () => {
    const out = splitIntoMessages('a\n\nb\n\nc\n\nd\n\ne');
    expect(out).toHaveLength(4);
    expect(out[3]).toBe('d\n\ne');
  });
});

describe('handleInboundWebhook — happy path', () => {
  it('generates, logs the outbound, sends, and marks delivered', async () => {
    const agent = agentReplying();
    const res = await handleInboundWebhook(inbound, agent);

    expect(agent.generate).toHaveBeenCalledOnce();
    expect(ghl.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ contactId: 'c1', text: '¿En qué te puedo ayudar?', channel: 'whatsapp' }),
    );
    // outbound persisted as a bot message before send
    expect(q.logMessage).toHaveBeenCalledWith(
      expect.objectContaining({ p_direction: 'outbound', p_sender_type: 'bot', p_content: '¿En qué te puedo ayudar?' }),
    );
    expect(q.setGhlMessageId).toHaveBeenCalledWith('msg-uuid', 'out-ghl-1');
    expect(q.markDelivered).toHaveBeenCalledWith('msg-uuid');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ replied: true });
  });
});

describe('handleInboundWebhook — per-tenant AI key & token accounting', () => {
  /** Agent result carrying usage, as Mastra returns it. */
  function agentWithUsage(text = '¿En qué te puedo ayudar?', usage = { inputTokens: 1500, outputTokens: 40 }): Agent {
    return { generate: vi.fn().mockResolvedValue({ text, steps: [{ text }], usage }) } as unknown as Agent;
  }

  it("resolves the key using the tenant's ai_key_ref", async () => {
    vi.mocked(q.loadTenantConfig).mockResolvedValue(
      tenant({ config: { ...tenant().config, aiKeyRef: 'MADI' } }),
    );
    vi.mocked(resolveAiApiKey).mockReturnValue({ apiKey: 'madi-key', source: 'MADI', fellBack: false });

    await handleInboundWebhook(inbound, agentWithUsage());

    expect(resolveAiApiKey).toHaveBeenCalledWith('openai', 'MADI');
  });

  it("bills the turn's tokens to the client, tagged with the key it ran on", async () => {
    vi.mocked(q.loadTenantConfig).mockResolvedValue(
      tenant({ config: { ...tenant().config, aiKeyRef: 'MADI' } }),
    );
    vi.mocked(resolveAiApiKey).mockReturnValue({ apiKey: 'madi-key', source: 'MADI', fellBack: false });

    await handleInboundWebhook(inbound, agentWithUsage());

    expect(q.logLlmUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        clientId: 'client1',
        ghlConversationId: 'conv1',
        callKind: 'front-desk',
        model: 'gpt-5.6-luna',
        keySource: 'MADI',
        usage: { inputTokens: 1500, outputTokens: 40, cachedInputTokens: 0 },
      }),
    );
  });

  it('a missing tenant secret still answers the lead, but logs the fallback', async () => {
    // The deliberate trade-off: misattributed spend beats a silent tenant. The
    // event is what keeps the degradation from being invisible.
    vi.mocked(q.loadTenantConfig).mockResolvedValue(
      tenant({ config: { ...tenant().config, aiKeyRef: 'MADI' } }),
    );
    vi.mocked(resolveAiApiKey).mockReturnValue({ apiKey: 'platform-key', source: 'platform', fellBack: true });

    const res = await handleInboundWebhook(inbound, agentWithUsage());

    expect(res.body).toMatchObject({ replied: true });
    expect(ghl.sendMessage).toHaveBeenCalled();
    expect(q.logBotEvent).toHaveBeenCalledWith(
      'client1',
      'conv1',
      'ai_key_fallback',
      expect.objectContaining({ keyRef: 'MADI', provider: 'openai' }),
    );
    // and the spend is honestly recorded against the platform key, not 'MADI'
    expect(q.logLlmUsage).toHaveBeenCalledWith(expect.objectContaining({ keySource: 'platform' }));
  });

  it('no usage in the result → no usage row (never invents numbers)', async () => {
    await handleInboundWebhook(inbound, agentReplying());
    expect(q.logLlmUsage).not.toHaveBeenCalled();
  });

  it('records the turn even when a human takes over mid-generation (tokens were burned)', async () => {
    vi.mocked(q.isHumanActive).mockResolvedValue(true);

    const res = await handleInboundWebhook(inbound, agentWithUsage());

    expect(res.body).toMatchObject({ ignored: 'suppressed during generation' });
    expect(ghl.sendMessage).not.toHaveBeenCalled();
    expect(q.logLlmUsage).toHaveBeenCalledWith(expect.objectContaining({ callKind: 'front-desk' }));
  });
});

describe('handleInboundWebhook — merge-key capture & recovery', () => {
  const fbNoPhone = { ...inbound, messageType: 'FB', phone: undefined };

  it('turn: captures phone/email from the live contact → passes email to sendMessage and persists the keys', async () => {
    ghl.getContact.mockResolvedValue({ name: 'Ana', phone: '+5215550000', email: 'ana@x.com' });
    await handleInboundWebhook(inbound, agentReplying());
    expect(ghl.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ email: 'ana@x.com' }));
    expect(q.setConversationContactKeys).toHaveBeenCalledWith('conv1', { phone: '+5215550000', email: 'ana@x.com' });
  });

  it('early capture: FB inbound with no phone → fetches the contact, logs its phone, persists its email', async () => {
    ghl.getContact.mockResolvedValue({ name: 'Ana', phone: '+5215550000', email: 'ana@x.com' });
    vi.mocked(q.loadTenantConfig).mockResolvedValue(tenant({ enabledChannels: ['facebook'] }));
    await handleInboundWebhook(fbNoPhone, agentReplying());
    expect(ghl.getContact).toHaveBeenCalledWith('c1');
    expect(q.logMessage).toHaveBeenCalledWith(
      expect.objectContaining({ p_direction: 'inbound', p_contact_phone: '+5215550000' }),
    );
    expect(q.setConversationContactKeys).toHaveBeenCalledWith('conv1', { email: 'ana@x.com' });
  });

  it('send recovers a merged-away contact → persists the survivor id on the conversation', async () => {
    ghl.sendMessage.mockResolvedValue({ ghlMessageId: 'm', resolvedContactId: 'survivor' });
    await handleInboundWebhook(inbound, agentReplying());
    expect(q.updateConversationContact).toHaveBeenCalledWith('conv1', 'survivor');
  });
});

describe('handleInboundWebhook — Meta CAPI attribution capture (0048)', () => {
  const metaCapi = { datasetId: 'ds1', pageId: 'pg1', tokenRef: 'MADI' };
  // The real shape GHL stores on a CTWA-ad contact (verified live 2026-08-01).
  const ctwaContact = {
    name: 'Ana',
    phone: '+5215550000',
    attributionSource: {
      sessionSource: 'Paid Social',
      medium: 'whatsapp',
      ctwaClid: 'AfjMi93Y-clid',
      adId: '120250989588970351',
      adName: 'Chatea con nosotros',
    },
  };

  it('CAPI tenant + CTWA contact → persists the click id (sticky) and queues lead_started', async () => {
    vi.mocked(q.loadTenantConfig).mockResolvedValue(tenant({ metaCapi } as Partial<TenantContext>));
    ghl.getContact.mockResolvedValue(ctwaContact);
    await handleInboundWebhook(inbound, agentReplying());
    expect(q.setConversationAttribution).toHaveBeenCalledWith('conv1', {
      ctwaClid: 'AfjMi93Y-clid',
      attribution: ctwaContact.attributionSource,
    });
    expect(queueCapiEvent).toHaveBeenCalledWith({
      tenant: expect.objectContaining({ tenantId: 't1' }),
      ghlConversationId: 'conv1',
      kind: 'lead_started',
      ctwaClid: 'AfjMi93Y-clid',
      phone: '+521',
    });
  });

  it('falls back to lastAttributionSource when attributionSource has no click id', async () => {
    vi.mocked(q.loadTenantConfig).mockResolvedValue(tenant({ metaCapi } as Partial<TenantContext>));
    ghl.getContact.mockResolvedValue({
      name: 'Ana',
      attributionSource: { sessionSource: 'Organic' },
      lastAttributionSource: { sessionSource: 'Paid Social', ctwaClid: 'Afj-last' },
    });
    await handleInboundWebhook(inbound, agentReplying());
    expect(queueCapiEvent).toHaveBeenCalledWith(expect.objectContaining({ ctwaClid: 'Afj-last' }));
  });

  it('tenant without meta_capi → no capture, even when the contact carries attribution', async () => {
    ghl.getContact.mockResolvedValue(ctwaContact);
    await handleInboundWebhook(inbound, agentReplying());
    expect(q.setConversationAttribution).not.toHaveBeenCalled();
    expect(queueCapiEvent).not.toHaveBeenCalled();
  });

  it('organic lead (no attribution on the contact) → nothing persisted or queued', async () => {
    vi.mocked(q.loadTenantConfig).mockResolvedValue(tenant({ metaCapi } as Partial<TenantContext>));
    ghl.getContact.mockResolvedValue({ name: 'Ana', phone: '+5215550000' });
    await handleInboundWebhook(inbound, agentReplying());
    expect(q.setConversationAttribution).not.toHaveBeenCalled();
    expect(queueCapiEvent).not.toHaveBeenCalled();
  });

  it('an attribution persist failure never blocks the turn', async () => {
    vi.mocked(q.loadTenantConfig).mockResolvedValue(tenant({ metaCapi } as Partial<TenantContext>));
    ghl.getContact.mockResolvedValue(ctwaContact);
    vi.mocked(q.setConversationAttribution).mockRejectedValue(new Error('db down'));
    const res = await handleInboundWebhook(inbound, agentReplying());
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ replied: true });
  });
});

describe('handleInboundWebhook — Meta CAPI status hook (0048)', () => {
  const noQuestion = 'Perfecto, quedamos así. ¡Gracias!'; // no "?" → classifier path opens

  it('a classifier-applied status reaches queueCapiStatusEvent (helper filters to completed)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '{"status":"completed"}' } }] }),
    }));
    await handleInboundWebhook(inbound, agentReplying(noQuestion));
    expect(queueCapiStatusEvent).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 't1' }), 'conv1', 'completed');
  });

  it('a refused status change (0044) signals nothing to Meta', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '{"status":"completed"}' } }] }),
    }));
    vi.mocked(q.updateConversationStatus).mockResolvedValue(false);
    await handleInboundWebhook(inbound, agentReplying(noQuestion));
    expect(queueCapiStatusEvent).not.toHaveBeenCalled();
  });
});

describe('handleInboundWebhook — active appointment guard', () => {
  const turnFrom = (agent: Agent) => {
    const call = vi.mocked(agent.generate).mock.calls[0] as unknown as [
      unknown,
      { requestContext: { get(k: string): unknown } },
    ];
    return call[1].requestContext.get('turn') as { activeAppointment?: { startTime: string; service?: string } };
  };

  it("injects the contact's active appointment into the turn context", async () => {
    vi.mocked(findUpcomingAppointment).mockResolvedValue({ startTime: '2026-07-04T14:30:00-07:00', service: 'Corte' });
    const agent = agentReplying();
    await handleInboundWebhook(inbound, agent);
    expect(turnFrom(agent).activeAppointment).toEqual({ startTime: '2026-07-04T14:30:00-07:00', service: 'Corte' });
  });

  it('leaves activeAppointment undefined when there is no active appointment', async () => {
    vi.mocked(findUpcomingAppointment).mockResolvedValue(null);
    const agent = agentReplying();
    await handleInboundWebhook(inbound, agent);
    expect(turnFrom(agent).activeAppointment).toBeUndefined();
  });

  it('skips the appointment lookup in demo mode (clean-start)', async () => {
    vi.mocked(q.getConversationPersona).mockResolvedValue({ activeRole: 'demo', roleStartedAt: null, demoStartedAt: null, promptVariant: null, reactivationRound: 0 });
    vi.mocked(findUpcomingAppointment).mockResolvedValue({ startTime: '2026-07-04T14:30:00-07:00', service: 'Corte' });
    const agent = agentReplying();
    await handleInboundWebhook(inbound, agent);
    expect(findUpcomingAppointment).not.toHaveBeenCalled();
    expect(turnFrom(agent).activeAppointment).toBeUndefined();
  });
});

describe('handleInboundWebhook — gates', () => {
  it('dedup: null conversationId → ignored, no agent run', async () => {
    vi.mocked(q.logMessage).mockResolvedValueOnce({ conversationId: null, messageId: null });
    const agent = agentReplying();
    const res = await handleInboundWebhook(inbound, agent);

    expect(agent.generate).not.toHaveBeenCalled();
    expect(res.body).toMatchObject({ ignored: 'duplicate message' });
  });

  it('suppression: isBotSuppressed → no generate, no send', async () => {
    vi.mocked(q.isBotSuppressed).mockResolvedValue(true);
    const agent = agentReplying();
    const res = await handleInboundWebhook(inbound, agent);

    expect(agent.generate).not.toHaveBeenCalled();
    expect(ghl.sendMessage).not.toHaveBeenCalled();
    expect(res.body).toMatchObject({ ignored: expect.stringContaining('suppressed') });
  });

  it('channel gate: inbound channel not enabled → ignored + event, no agent run', async () => {
    vi.mocked(q.loadTenantConfig).mockResolvedValue(tenant({ enabledChannels: ['facebook'] }));
    const agent = agentReplying();
    const res = await handleInboundWebhook(inbound, agent); // inbound is WhatsApp

    expect(agent.generate).not.toHaveBeenCalled();
    expect(q.logBotEvent).toHaveBeenCalledWith('client1', 'conv1', 'channel_disabled', expect.anything());
    expect(res.body).toMatchObject({ ignored: 'channel not enabled for tenant' });
  });

  it('keyword gate: no keyword on a non-activated convo → ignored, no agent run', async () => {
    vi.mocked(q.loadTenantConfig).mockResolvedValue(tenant({ triggerKeywords: ['agente'] }));
    vi.mocked(q.botActivation).mockResolvedValue('gated');
    const agent = agentReplying();
    const res = await handleInboundWebhook(inbound, agent); // body 'hola' has no keyword

    expect(agent.generate).not.toHaveBeenCalled();
    expect(res.body).toMatchObject({ ignored: 'trigger keyword required' });
  });
});

describe('handleInboundWebhook — delivery failure', () => {
  it('send fails both attempts → row left pending, error logged, no setGhlMessageId', async () => {
    ghl.sendMessage.mockRejectedValue(new Error('ghl 500'));
    const agent = agentReplying();
    const res = await handleInboundWebhook(inbound, agent);

    expect(ghl.sendMessage).toHaveBeenCalledTimes(2); // inline retry
    expect(q.setGhlMessageId).not.toHaveBeenCalled();
    expect(q.markDelivered).not.toHaveBeenCalled();
    expect(q.logError).toHaveBeenCalledWith('client1', 'conv1', 'delivery_error', expect.anything());
    expect(res.status).toBe(200);
  });
});

describe('handleInboundWebhook — accepted without id', () => {
  it('GHL accepts (2xx) but returns no id → no retry, marked delivered, not left pending', async () => {
    ghl.sendMessage.mockResolvedValue({ ghlMessageId: '' });
    const agent = agentReplying();
    const res = await handleInboundWebhook(inbound, agent);

    expect(ghl.sendMessage).toHaveBeenCalledTimes(1); // accepted → never retried (no double-send)
    expect(q.setGhlMessageId).not.toHaveBeenCalled(); // no id to store
    expect(q.markDelivered).toHaveBeenCalledWith('msg-uuid'); // delivered → cron won't re-send
    expect(q.logError).not.toHaveBeenCalledWith('client1', 'conv1', 'delivery_error', expect.anything());
    expect(res.status).toBe(200);
  });
});

describe('handleInboundWebhook — contact-name backstop', () => {
  // Tenant that opted into the deterministic name-correction backstop.
  const nameConfirmTenant = () =>
    tenant({ config: { ...tenant().config, promptOverrides: { confirmContactName: true } } });

  // Opening window: the bot already asked for the name (1 prior bot msg), lead just replied.
  const openingHistory = [
    { direction: 'outbound', senderType: 'bot', content: '¿Te llamas X, o con quién tengo el gusto?', sentAt: '' },
    { direction: 'inbound', senderType: 'lead', content: 'Carlos', sentAt: '' },
  ] as Awaited<ReturnType<typeof q.loadRecentMessages>>;

  // Stub the extractor's model call (the only fetch on this path — the agent reply has a '?',
  // so classifyConversationOutcome short-circuits without fetching).
  const mockExtractor = (name: string | null) =>
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ choices: [{ message: { content: JSON.stringify({ name }) } }] }),
      }),
    );

  // Regression: the OpenAI aux calls sent `max_tokens`, which the gpt-5 family rejects with
  // a 400 — so this backstop (and the status classifier) had NEVER run on the platform
  // default. Fire-and-forget hid it: nothing but a log line. And the naive fix is a trap of
  // its own — `max_completion_tokens` counts reasoning tokens, so the old 32 returns 200
  // with an empty body. Assert the parameter AND that the budget is not a token-sized one.
  it('sends max_completion_tokens (never max_tokens) with room for a reasoning pass', async () => {
    vi.mocked(q.loadTenantConfig).mockResolvedValue(nameConfirmTenant());
    vi.mocked(q.loadRecentMessages).mockResolvedValue(openingHistory);
    ghl.getContact.mockResolvedValue({ name: 'Gimnasio X' });
    mockExtractor('Carlos');

    await handleInboundWebhook(inbound, agentReplying('¿Te agendo el sábado?'));

    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const call = fetchMock.mock.calls.find(([url]) => String(url).includes('openai.com'));
    expect(call, 'the extractor never called OpenAI').toBeTruthy();
    const body = JSON.parse((call![1] as { body: string }).body) as Record<string, unknown>;
    expect(body).not.toHaveProperty('max_tokens');
    expect(body.max_completion_tokens).toBeGreaterThanOrEqual(200);
    // The budget is the fallback; on a model that takes it, the reasoning pass is turned
    // off outright so the 300 tokens go to the answer.
    expect(body.reasoning_effort).toBe('none');
  });

  // The other half of the same guard: ai_model may name a model that 400s on the
  // parameter, and a 400 on a fire-and-forget call is a silent death.
  it('omits reasoning_effort on a model that does not accept it', async () => {
    vi.mocked(q.loadTenantConfig).mockResolvedValue(
      tenant({
        config: { ...nameConfirmTenant().config, model: 'gpt-4o-mini' },
      }),
    );
    vi.mocked(q.loadRecentMessages).mockResolvedValue(openingHistory);
    ghl.getContact.mockResolvedValue({ name: 'Gimnasio X' });
    mockExtractor('Carlos');

    await handleInboundWebhook(inbound, agentReplying('¿Te agendo el sábado?'));

    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const call = fetchMock.mock.calls.find(([url]) => String(url).includes('openai.com'));
    const body = JSON.parse((call![1] as { body: string }).body) as Record<string, unknown>;
    expect(body).not.toHaveProperty('reasoning_effort');
  });

  it('flag on + opening window + new name → updates the GHL contact name', async () => {
    vi.mocked(q.loadTenantConfig).mockResolvedValue(nameConfirmTenant());
    vi.mocked(q.loadRecentMessages).mockResolvedValue(openingHistory);
    ghl.getContact.mockResolvedValue({ name: 'Gimnasio FitZone' });
    mockExtractor('Carlos');

    await handleInboundWebhook(inbound, agentReplying());

    expect(ghl.updateContactName).toHaveBeenCalledWith('c1', { firstName: 'Carlos', lastName: '' });
  });

  it('splits a full name into firstName/lastName', async () => {
    vi.mocked(q.loadTenantConfig).mockResolvedValue(nameConfirmTenant());
    vi.mocked(q.loadRecentMessages).mockResolvedValue(openingHistory);
    ghl.getContact.mockResolvedValue({ name: 'Gimnasio FitZone' });
    mockExtractor('Ana López');

    await handleInboundWebhook(inbound, agentReplying());

    expect(ghl.updateContactName).toHaveBeenCalledWith('c1', { firstName: 'Ana', lastName: 'López' });
  });

  it('extracted name equals stored name (case-insensitive) → no update', async () => {
    vi.mocked(q.loadTenantConfig).mockResolvedValue(nameConfirmTenant());
    vi.mocked(q.loadRecentMessages).mockResolvedValue(openingHistory);
    ghl.getContact.mockResolvedValue({ name: 'Carlos' });
    mockExtractor('carlos');

    await handleInboundWebhook(inbound, agentReplying());

    expect(ghl.updateContactName).not.toHaveBeenCalled();
  });

  it('extractor returns null (no personal name given) → no update', async () => {
    vi.mocked(q.loadTenantConfig).mockResolvedValue(nameConfirmTenant());
    vi.mocked(q.loadRecentMessages).mockResolvedValue(openingHistory);
    ghl.getContact.mockResolvedValue({ name: 'Gimnasio FitZone' });
    mockExtractor(null);

    await handleInboundWebhook(inbound, agentReplying());

    expect(ghl.updateContactName).not.toHaveBeenCalled();
  });

  it('flag OFF → backstop never runs, even in the opening window', async () => {
    // default tenant has confirmContactName unset
    vi.mocked(q.loadRecentMessages).mockResolvedValue(openingHistory);
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await handleInboundWebhook(inbound, agentReplying());

    expect(ghl.updateContactName).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled(); // no extractor call
  });

  it('flag on but bot has not spoken yet (priorBotMessages=0) → skipped', async () => {
    vi.mocked(q.loadTenantConfig).mockResolvedValue(nameConfirmTenant());
    vi.mocked(q.loadRecentMessages).mockResolvedValue([
      { direction: 'inbound', senderType: 'lead', content: 'Carlos', sentAt: '' },
    ] as Awaited<ReturnType<typeof q.loadRecentMessages>>);
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await handleInboundWebhook(inbound, agentReplying());

    expect(ghl.updateContactName).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('handleInboundWebhook — campaign prompt variants', () => {
  const withVariants = () =>
    tenant({
      keywordVariants: { 'promo laser': 'laser-promo', 'laser ya': 'laser-promo' },
      config: { ...tenant().config, promptVariants: { 'laser-promo': { offering: 'Promo' } } },
    });

  it('pins the variant on first touch and logs variant_assigned', async () => {
    vi.mocked(q.loadTenantConfig).mockResolvedValue(withVariants());
    vi.mocked(q.setPromptVariant).mockResolvedValue(true);
    await handleInboundWebhook({ ...inbound, body: 'Hola, vi su PROMO LASER' }, agentReplying());
    expect(q.setPromptVariant).toHaveBeenCalledWith('conv1', 'laser-promo');
    expect(q.logBotEvent).toHaveBeenCalledWith('client1', 'conv1', 'variant_assigned',
      expect.objectContaining({ variant: 'laser-promo', keyword: 'promo laser', known: true }));
  });

  it('an already-pinned conversation logs nothing (sticky no-op)', async () => {
    vi.mocked(q.loadTenantConfig).mockResolvedValue(withVariants());
    vi.mocked(q.setPromptVariant).mockResolvedValue(false);
    await handleInboundWebhook({ ...inbound, body: 'laser ya' }, agentReplying());
    expect(q.setPromptVariant).toHaveBeenCalled();
    expect(q.logBotEvent).not.toHaveBeenCalledWith('client1', 'conv1', 'variant_assigned', expect.anything());
  });

  it('a keyword mapped to a missing variant key logs known:false (misconfig fingerprint)', async () => {
    const t = withVariants();
    (t.config as { promptVariants: unknown }).promptVariants = {}; // key deleted, mapping left behind
    vi.mocked(q.loadTenantConfig).mockResolvedValue(t);
    vi.mocked(q.setPromptVariant).mockResolvedValue(true);
    await handleInboundWebhook({ ...inbound, body: 'promo laser' }, agentReplying());
    expect(q.logBotEvent).toHaveBeenCalledWith('client1', 'conv1', 'variant_assigned',
      expect.objectContaining({ variant: 'laser-promo', known: false }));
  });

  it('no variant call at all when the message matches nothing', async () => {
    vi.mocked(q.loadTenantConfig).mockResolvedValue(withVariants());
    await handleInboundWebhook(inbound, agentReplying()); // "hola"
    expect(q.setPromptVariant).not.toHaveBeenCalled();
  });

  it('a setPromptVariant failure never blocks the turn', async () => {
    vi.mocked(q.loadTenantConfig).mockResolvedValue(withVariants());
    vi.mocked(q.setPromptVariant).mockRejectedValue(new Error('db down'));
    const agent = agentReplying();
    const res = await handleInboundWebhook({ ...inbound, body: 'promo laser' }, agent);
    expect(agent.generate).toHaveBeenCalled();
    expect(res.body).toMatchObject({ replied: true });
  });

  it("threads the conversation's pinned variant into the turn context", async () => {
    vi.mocked(q.getConversationPersona).mockResolvedValue({ activeRole: null, roleStartedAt: null, demoStartedAt: null, promptVariant: 'laser-promo', reactivationRound: 0 });
    const agent = agentReplying();
    await handleInboundWebhook(inbound, agent);
    const call = vi.mocked(agent.generate).mock.calls[0] as unknown as [unknown, { requestContext: { get(k: string): unknown } }];
    const turn = call[1].requestContext.get('turn') as { promptVariant?: string };
    expect(turn.promptVariant).toBe('laser-promo');
  });
});

describe('handleInboundWebhook — demo-mode guards (roleplay must not touch real state)', () => {
  const demoPersona = { activeRole: 'demo', roleStartedAt: null, demoStartedAt: '2026-07-29T10:00:00Z', promptVariant: null, reactivationRound: 0 };
  /** A running session: far-future expiry and a budget the default message count can't reach. */
  const liveSession = {
    id: 'sess-1',
    activatedAt: '2026-07-29T10:00:00Z',
    expiresAt: '2099-01-01T00:00:00Z',
    messageBudget: 15,
    personaVersion: 1,
    leadData: { businessName: 'Clínica Sonrisa', businessType: 'clínica dental' },
    promptOverrides: { identity: 'PERSONA GENERADA' },
    simulatedBooking: null,
  };
  const noQuestion = 'Entendido, muchas gracias por tu visita.'; // no "?" → classifier path opens

  it('control: outside demo, a no-question reply triggers the outcome classifier', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: false, status: 500 }); // classifier fails safe
    vi.stubGlobal('fetch', fetchSpy);
    await handleInboundWebhook(inbound, agentReplying(noQuestion));
    expect(fetchSpy).toHaveBeenCalled();
  });

  it('demo: the outcome classifier is skipped entirely', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    vi.mocked(q.getConversationPersona).mockResolvedValue(demoPersona);
    await handleInboundWebhook(inbound, agentReplying(noQuestion));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(q.updateConversationStatus).not.toHaveBeenCalled();
  });

  it('a refused status change does not mirror its tag onto the contact (0044)', async () => {
    // The lead is `awaiting_human` (tagged by a person in GHL); the classifier guesses
    // `standby`. The RPC refuses, so the contact must not also get `bot-standby` —
    // that tag is what would make the state look settled to whoever is looking in GHL.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '{"status":"standby"}' } }] }),
    }));
    vi.mocked(q.updateConversationStatus).mockResolvedValue(false);
    await handleInboundWebhook(inbound, agentReplying(noQuestion));
    expect(q.updateConversationStatus).toHaveBeenCalledWith('conv1', 'standby');
    expect(ghl.addContactTags).not.toHaveBeenCalledWith('c1', ['bot-standby']);
  });

  it('control: the same classification DOES tag when the RPC applied it', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '{"status":"standby"}' } }] }),
    }));
    await handleInboundWebhook(inbound, agentReplying(noQuestion));
    expect(ghl.addContactTags).toHaveBeenCalledWith('c1', ['bot-standby']);
  });

  it('control: outside demo, a bot reply schedules follow-up position 1', async () => {
    vi.mocked(q.loadTenantConfig).mockResolvedValue(
      tenant({ config: { ...tenant().config, followUpCadence: [30, 180] } }),
    );
    await handleInboundWebhook(inbound, agentReplying());
    expect(q.scheduleFollowUp).toHaveBeenCalledWith('cv-uuid', 1, 30, 'America/Mexico_City', undefined, 'cadence', 0);
  });

  it('round 1: arms the platform taper cadence (6h) stamped with round 1, not the tenant ladder', async () => {
    vi.mocked(q.loadTenantConfig).mockResolvedValue(
      tenant({ config: { ...tenant().config, followUpCadence: [30, 180] } }),
    );
    vi.mocked(q.getConversationPersona).mockResolvedValue({
      activeRole: null, roleStartedAt: null, demoStartedAt: null, promptVariant: null, reactivationRound: 1,
    });
    await handleInboundWebhook(inbound, agentReplying());
    expect(q.scheduleFollowUp).toHaveBeenCalledWith('cv-uuid', 1, 360, 'America/Mexico_City', undefined, 'cadence', 1);
  });

  it('tenant follow_up_rounds overrides the taper shape and the round count', async () => {
    vi.mocked(q.loadTenantConfig).mockResolvedValue(
      tenant({ config: { ...tenant().config, followUpCadence: [30, 180], followUpRounds: [[15]] } }),
    );
    vi.mocked(q.getConversationPersona).mockResolvedValue({
      activeRole: null, roleStartedAt: null, demoStartedAt: null, promptVariant: null, reactivationRound: 1,
    });
    await handleInboundWebhook(inbound, agentReplying());
    expect(q.scheduleFollowUp).toHaveBeenCalledWith('cv-uuid', 1, 15, 'America/Mexico_City', undefined, 'cadence', 1);
  });

  it('all rounds consumed: the bot still replies but arms nothing', async () => {
    vi.mocked(q.loadTenantConfig).mockResolvedValue(
      tenant({ config: { ...tenant().config, followUpCadence: [30, 180] } }),
    );
    vi.mocked(q.getConversationPersona).mockResolvedValue({
      activeRole: null, roleStartedAt: null, demoStartedAt: null, promptVariant: null, reactivationRound: 3,
    });
    await handleInboundWebhook(inbound, agentReplying());
    expect(ghl.sendMessage).toHaveBeenCalled();
    expect(q.scheduleFollowUp).not.toHaveBeenCalled();
  });

  it('follow_up_rounds: [] = round 0 only, ghosting twice ends pursuit', async () => {
    vi.mocked(q.loadTenantConfig).mockResolvedValue(
      tenant({ config: { ...tenant().config, followUpCadence: [30, 180], followUpRounds: [] } }),
    );
    vi.mocked(q.getConversationPersona).mockResolvedValue({
      activeRole: null, roleStartedAt: null, demoStartedAt: null, promptVariant: null, reactivationRound: 1,
    });
    await handleInboundWebhook(inbound, agentReplying());
    expect(q.scheduleFollowUp).not.toHaveBeenCalled();
  });

  it('help mode (0049): an upcoming appointment suppresses cadence arming — support, not pursuit', async () => {
    vi.mocked(q.loadTenantConfig).mockResolvedValue(
      tenant({ config: { ...tenant().config, followUpCadence: [30, 180] } }),
    );
    vi.mocked(findUpcomingAppointment).mockResolvedValue({ startTime: '2099-07-04T14:30:00-07:00', service: 'Corte' });
    await handleInboundWebhook(inbound, agentReplying());
    expect(ghl.sendMessage).toHaveBeenCalled();
    expect(q.scheduleFollowUp).not.toHaveBeenCalled();
  });

  it('a persona read failure fails open: arms round 0 (never silences the lead)', async () => {
    vi.mocked(q.loadTenantConfig).mockResolvedValue(
      tenant({ config: { ...tenant().config, followUpCadence: [30, 180] } }),
    );
    vi.mocked(q.getConversationPersona).mockRejectedValue(new Error('db down'));
    await handleInboundWebhook(inbound, agentReplying());
    expect(q.scheduleFollowUp).toHaveBeenCalledWith('cv-uuid', 1, 30, 'America/Mexico_City', undefined, 'cadence', 0);
  });

  it('demo: the cadence ladder never fires — its nudges would shatter the roleplay', async () => {
    vi.mocked(q.loadTenantConfig).mockResolvedValue(
      tenant({ config: { ...tenant().config, followUpCadence: [30, 180] } }),
    );
    vi.mocked(q.getConversationPersona).mockResolvedValue(demoPersona);
    await handleInboundWebhook(inbound, agentReplying());
    expect(q.scheduleFollowUp).not.toHaveBeenCalledWith(
      expect.anything(), expect.anything(), expect.anything(), expect.anything(), expect.anything(), 'cadence',
    );
  });

  // The reminder ladder belongs to the session funnel. A manual keyword demo (§5b) is a
  // live showing with no budget and no expiry: nothing can strand its lead, so there is
  // nothing to rescue, and a "(tu demo sigue activo)" line half an hour later lands on a
  // real prospect's thread. Neither ladder — the cadence would be worse than the reminders,
  // since the reactivation agent is persona-blind and would nudge from inside the roleplay.
  it('manual keyword demo (no session): arms NOTHING, neither ladder', async () => {
    vi.mocked(q.loadTenantConfig).mockResolvedValue(
      tenant({ config: { ...tenant().config, followUpCadence: [30, 180] } }),
    );
    vi.mocked(q.getConversationPersona).mockResolvedValue(demoPersona);
    await handleInboundWebhook(inbound, agentReplying());
    expect(q.scheduleFollowUp).not.toHaveBeenCalled();
  });

  it('session demo: arms the demo reminder ladder instead of going silent', async () => {
    // Before 0043 this scheduled nothing at all, which left a lead who walked away
    // mid-demo unreachable forever — expiry is only evaluated on the next inbound.
    vi.mocked(q.getConversationPersona).mockResolvedValue(demoPersona);
    vi.mocked(q.getActiveDemoSession).mockResolvedValue(liveSession as never);
    await handleInboundWebhook(inbound, agentReplying());
    expect(q.scheduleFollowUp).toHaveBeenCalledWith(
      'cv-uuid', 1, 30, 'America/Mexico_City', undefined, 'demo', 0,
    );
  });

  it('session demo: the rung follows what already landed, so reminder #2 is reachable', async () => {
    vi.mocked(q.getConversationPersona).mockResolvedValue(demoPersona);
    vi.mocked(q.getActiveDemoSession).mockResolvedValue(liveSession as never);
    vi.mocked(q.countSentDemoReminders).mockResolvedValue(1);
    await handleInboundWebhook(inbound, agentReplying());
    expect(q.scheduleFollowUp).toHaveBeenCalledWith(
      'cv-uuid', 2, 240, 'America/Mexico_City', undefined, 'demo', 0,
    );
  });

  it('session demo: past the last rung nothing is re-armed (the runner closes the demo there)', async () => {
    vi.mocked(q.getConversationPersona).mockResolvedValue(demoPersona);
    vi.mocked(q.getActiveDemoSession).mockResolvedValue(liveSession as never);
    vi.mocked(q.countSentDemoReminders).mockResolvedValue(3);
    await handleInboundWebhook(inbound, agentReplying());
    expect(q.scheduleFollowUp).not.toHaveBeenCalled();
  });

  it('demo: the contact-name backstop is skipped even inside its re-opened window', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    vi.mocked(q.loadTenantConfig).mockResolvedValue(
      tenant({ config: { ...tenant().config, promptOverrides: { confirmContactName: true } } }),
    );
    vi.mocked(q.getConversationPersona).mockResolvedValue(demoPersona);
    // Demo-truncated history: exactly 1 prior bot message → the window would be open.
    vi.mocked(q.loadRecentMessages).mockResolvedValue([
      { direction: 'outbound', senderType: 'bot', content: '¿Me confirmas tu nombre?', sentAt: '2026-07-29T10:01:00Z' },
    ]);
    await handleInboundWebhook({ ...inbound, body: 'Soy Cliente Ficticio' }, agentReplying());
    expect(fetchSpy).not.toHaveBeenCalled();          // no extract-name model call
    expect(ghl.updateContactName).not.toHaveBeenCalled();
  });

  it('control: outside demo the backstop runs in the same window', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: false, status: 500 }); // backstop fails safe
    vi.stubGlobal('fetch', fetchSpy);
    vi.mocked(q.loadTenantConfig).mockResolvedValue(
      tenant({ config: { ...tenant().config, promptOverrides: { confirmContactName: true } } }),
    );
    vi.mocked(q.loadRecentMessages).mockResolvedValue([
      { direction: 'outbound', senderType: 'bot', content: '¿Me confirmas tu nombre?', sentAt: '2026-07-29T10:01:00Z' },
    ]);
    await handleInboundWebhook({ ...inbound, body: 'Soy Carlos' }, agentReplying());
    expect(fetchSpy).toHaveBeenCalled();
  });
});

describe('handleInboundWebhook — demo sessions (budget, expiry, closer flip)', () => {
  const demoPersona = { activeRole: 'demo', roleStartedAt: '2026-07-29T10:00:00Z', demoStartedAt: '2026-07-29T10:00:00Z', promptVariant: null, reactivationRound: 0 };
  const session = (over: Record<string, unknown> = {}) => ({
    id: 'sess-1',
    activatedAt: '2026-07-29T10:00:00Z',
    expiresAt: '2099-01-01T00:00:00Z',
    messageBudget: 15,
    personaVersion: 1,
    leadData: { businessName: 'Clínica Sonrisa', businessType: 'clínica dental' },
    promptOverrides: { identity: 'PERSONA GENERADA' },
    simulatedBooking: null,
    ...over,
  });
  const turnFrom = (agent: Agent) => {
    const call = vi.mocked(agent.generate).mock.calls[0] as unknown as [unknown, { requestContext: { get(k: string): unknown } }];
    return call[1].requestContext.get('turn') as { activeRole?: string; demoHandoff?: { reason: string; businessName?: string } };
  };
  const tenantFrom = (agent: Agent) => {
    const call = vi.mocked(agent.generate).mock.calls[0] as unknown as [unknown, { requestContext: { get(k: string): unknown } }];
    return call[1].requestContext.get('tenant') as TenantContext;
  };

  it('active session under budget → session persona overlaid, demo continues', async () => {
    vi.mocked(q.getConversationPersona).mockResolvedValue(demoPersona);
    vi.mocked(q.getActiveDemoSession).mockResolvedValue(session() as never);
    vi.mocked(q.countBotMessagesSince).mockResolvedValue(3);
    const agent = agentReplying();
    await handleInboundWebhook(inbound, agent);
    expect(q.endDemoSession).not.toHaveBeenCalled();
    expect(turnFrom(agent).activeRole).toBe('demo');
    expect(tenantFrom(agent).config.demoPromptOverrides).toEqual({ identity: 'PERSONA GENERADA' });
  });

  it('budget exhausted → session ended, closer answers with the handoff context', async () => {
    vi.mocked(q.getConversationPersona)
      .mockResolvedValueOnce(demoPersona) // turn-time read: still demo
      .mockResolvedValue({ activeRole: null, roleStartedAt: '2026-07-29T12:00:00Z', demoStartedAt: null, promptVariant: null, reactivationRound: 0 }); // re-read after flip
    vi.mocked(q.getActiveDemoSession).mockResolvedValue(session() as never);
    vi.mocked(q.countBotMessagesSince).mockResolvedValue(15);
    const agent = agentReplying();
    await handleInboundWebhook(inbound, agent);

    expect(q.endDemoSession).toHaveBeenCalledWith('sess-1', 'exhausted');
    expect(q.logBotEvent).toHaveBeenCalledWith('client1', 'conv1', 'demo_session_ended',
      expect.objectContaining({ reason: 'exhausted' }));
    // The handover message is DETERMINISTIC — the model is not consulted on this turn,
    // because twice in production it answered the lead's last in-character question and
    // pitched instead of announcing that the demo was over.
    expect(agent.generate).not.toHaveBeenCalled();
    const sent = ghl.sendMessage.mock.calls.map((c) => (c[0] as { text: string }).text).join('\n');
    expect(sent).toContain('Hasta aquí llega la demo');
    expect(sent).toContain('Clínica Sonrisa');
    expect(sent).toContain('24/7');
  });

  it('expired session → same flip with reason expired', async () => {
    vi.mocked(q.getConversationPersona)
      .mockResolvedValueOnce(demoPersona)
      .mockResolvedValue({ activeRole: null, roleStartedAt: '2026-07-29T12:00:00Z', demoStartedAt: null, promptVariant: null, reactivationRound: 0 });
    vi.mocked(q.getActiveDemoSession).mockResolvedValue(session({ expiresAt: '2020-01-01T00:00:00Z' }) as never);
    vi.mocked(q.countBotMessagesSince).mockResolvedValue(2);
    const agent = agentReplying();
    await handleInboundWebhook(inbound, agent);
    expect(q.endDemoSession).toHaveBeenCalledWith('sess-1', 'expired');
    expect(agent.generate).not.toHaveBeenCalled();
    const sent = ghl.sendMessage.mock.calls.map((c) => (c[0] as { text: string }).text).join('\n');
    expect(sent).toContain('se cerró por tiempo'); // expiry is stated, not glossed over
  });

  it('no session (manual keyword demo) → unchanged: tenant demo overrides, no budget', async () => {
    vi.mocked(q.getConversationPersona).mockResolvedValue(demoPersona);
    vi.mocked(q.getActiveDemoSession).mockResolvedValue(null);
    const agent = agentReplying();
    await handleInboundWebhook(inbound, agent);
    expect(q.countBotMessagesSince).not.toHaveBeenCalled();
    expect(q.endDemoSession).not.toHaveBeenCalled();
    expect(turnFrom(agent).activeRole).toBe('demo');
  });

  it('a session read failure degrades to a manual demo, never a dropped reply', async () => {
    vi.mocked(q.getConversationPersona).mockResolvedValue(demoPersona);
    vi.mocked(q.getActiveDemoSession).mockRejectedValue(new Error('db down'));
    const agent = agentReplying();
    const res = await handleInboundWebhook(inbound, agent);
    expect(res.body).toMatchObject({ replied: true });
    expect(turnFrom(agent).activeRole).toBe('demo');
  });
});

describe('handleInboundWebhook — demo funnel tags + off-keyword session close', () => {
  const demoPersona = { activeRole: 'demo', roleStartedAt: '2026-07-29T10:00:00Z', demoStartedAt: '2026-07-29T10:00:00Z', promptVariant: null, reactivationRound: 0 };
  const demoTenant = () => tenant({ demoOffKeywords: ['demo off'] });
  const activeSession = {
    id: 'sess-1', activatedAt: '2026-07-29T10:00:00Z', expiresAt: '2099-01-01T00:00:00Z',
    messageBudget: 15, personaVersion: 1, leadData: { businessName: 'Sonrisa' }, promptOverrides: {}, simulatedBooking: null,
  };

  it('budget exhausted → contact tagged demo-completada (a completed demo is a hot lead)', async () => {
    vi.mocked(q.getConversationPersona)
      .mockResolvedValueOnce(demoPersona)
      .mockResolvedValue({ activeRole: null, roleStartedAt: '2026-07-29T12:00:00Z', demoStartedAt: null, promptVariant: null, reactivationRound: 0 });
    vi.mocked(q.getActiveDemoSession).mockResolvedValue(activeSession as never);
    vi.mocked(q.countBotMessagesSince).mockResolvedValue(15);
    await handleInboundWebhook(inbound, agentReplying());
    expect(ghl.addContactTags).toHaveBeenCalledWith('c1', ['demo-completada']);
  });

  it('expired session → tagged demo-incompleta (retargeting pool)', async () => {
    vi.mocked(q.getConversationPersona)
      .mockResolvedValueOnce(demoPersona)
      .mockResolvedValue({ activeRole: null, roleStartedAt: '2026-07-29T12:00:00Z', demoStartedAt: null, promptVariant: null, reactivationRound: 0 });
    vi.mocked(q.getActiveDemoSession).mockResolvedValue({ ...activeSession, expiresAt: '2020-01-01T00:00:00Z' } as never);
    vi.mocked(q.countBotMessagesSince).mockResolvedValue(2);
    await handleInboundWebhook(inbound, agentReplying());
    expect(ghl.addContactTags).toHaveBeenCalledWith('c1', ['demo-incompleta']);
  });

  it('demo-off keyword with an active session → session ended (closed) + tagged, not orphaned', async () => {
    vi.mocked(q.loadTenantConfig).mockResolvedValue(demoTenant());
    vi.mocked(q.getActiveDemoSession).mockResolvedValue(activeSession as never);
    await handleInboundWebhook({ ...inbound, body: 'demo off' }, agentReplying());
    expect(q.endDemoSession).toHaveBeenCalledWith('sess-1', 'closed');
    expect(q.setActiveRole).not.toHaveBeenCalled(); // the RPC flips the role itself
    expect(q.logBotEvent).toHaveBeenCalledWith('client1', 'conv1', 'demo_session_ended',
      expect.objectContaining({ reason: 'closed' }));
    expect(ghl.addContactTags).toHaveBeenCalledWith('c1', ['demo-incompleta']);
  });

  it('demo-off keyword with NO session (manual demo) → plain persona flip, unchanged', async () => {
    vi.mocked(q.loadTenantConfig).mockResolvedValue(demoTenant());
    vi.mocked(q.getActiveDemoSession).mockResolvedValue(null);
    await handleInboundWebhook({ ...inbound, body: 'demo off' }, agentReplying());
    expect(q.setActiveRole).toHaveBeenCalledWith('conv1', null);
    expect(q.endDemoSession).not.toHaveBeenCalled();
  });

  it('a tag failure never blocks the closer turn', async () => {
    vi.mocked(q.getConversationPersona)
      .mockResolvedValueOnce(demoPersona)
      .mockResolvedValue({ activeRole: null, roleStartedAt: '2026-07-29T12:00:00Z', demoStartedAt: null, promptVariant: null, reactivationRound: 0 });
    vi.mocked(q.getActiveDemoSession).mockResolvedValue(activeSession as never);
    vi.mocked(q.countBotMessagesSince).mockResolvedValue(15);
    ghl.addContactTags.mockRejectedValue(new Error('ghl 500'));
    const res = await handleInboundWebhook(inbound, agentReplying());
    expect(res.body).toMatchObject({ replied: true });
  });
});

describe('handleInboundWebhook — demo self-block guard + closer context hygiene', () => {
  const demoPersona = { activeRole: 'demo', roleStartedAt: '2026-07-30T14:00:00Z', demoStartedAt: '2026-07-30T14:00:00Z', promptVariant: null, reactivationRound: 0 };
  const session = (over: Record<string, unknown> = {}) => ({
    id: 'sess-1', activatedAt: '2026-07-30T14:00:00Z', expiresAt: '2099-01-01T00:00:00Z',
    messageBudget: 15, personaVersion: 3, leadData: { businessName: 'Beautiful Desire' },
    promptOverrides: { identity: 'P' }, simulatedBooking: null, ...over,
  });
  const turnFrom = (agent: Agent) => {
    const call = vi.mocked(agent.generate).mock.calls[0] as unknown as [unknown, { requestContext: { get(k: string): unknown } }];
    return call[1].requestContext.get('turn') as { activeAppointment?: { startTime: string; service?: string } };
  };
  const modelMessages = (agent: Agent) =>
    (vi.mocked(agent.generate).mock.calls[0] as unknown as [{ role: string; content: string }[], unknown])[0];

  it("surfaces the demo's OWN simulated booking as activeAppointment (kills the 'ya se ocupó' loop)", async () => {
    vi.mocked(q.getConversationPersona).mockResolvedValue(demoPersona);
    vi.mocked(q.getActiveDemoSession).mockResolvedValue(session({
      simulatedBooking: { startTime: '2026-08-01T17:00:00.000Z', serviceName: 'Botox', label: 'sábado 1 de agosto, 10:00 a.m.' },
    }) as never);
    vi.mocked(q.firstInboundAfter).mockResolvedValue('2026-07-30T14:01:00Z');
    vi.mocked(q.countBotMessagesSince).mockResolvedValue(3);
    const agent = agentReplying();
    await handleInboundWebhook(inbound, agent);
    expect(turnFrom(agent).activeAppointment).toEqual({ startTime: '2026-08-01T17:00:00.000Z', service: 'Botox' });
    // A demo must never see the contact's REAL appointment.
    expect(findUpcomingAppointment).not.toHaveBeenCalled();
  });

  it('demo with no booking yet → no activeAppointment, real one still not consulted', async () => {
    vi.mocked(q.getConversationPersona).mockResolvedValue(demoPersona);
    vi.mocked(q.getActiveDemoSession).mockResolvedValue(session() as never);
    vi.mocked(q.firstInboundAfter).mockResolvedValue(null);
    vi.mocked(q.countBotMessagesSince).mockResolvedValue(3);
    const agent = agentReplying();
    await handleInboundWebhook(inbound, agent);
    expect(turnFrom(agent).activeAppointment).toBeUndefined();
    expect(findUpcomingAppointment).not.toHaveBeenCalled();
  });

  it("budget starts at the lead's first in-character message, not at the announcement", async () => {
    vi.mocked(q.getConversationPersona).mockResolvedValue(demoPersona);
    vi.mocked(q.getActiveDemoSession).mockResolvedValue(session() as never);
    vi.mocked(q.firstInboundAfter).mockResolvedValue('2026-07-30T14:01:00Z');
    vi.mocked(q.countBotMessagesSince).mockResolvedValue(3);
    await handleInboundWebhook(inbound, agentReplying());
    expect(q.firstInboundAfter).toHaveBeenCalledWith('cv-uuid', '2026-07-30T14:00:00Z');
    expect(q.countBotMessagesSince).toHaveBeenCalledWith('cv-uuid', '2026-07-30T14:01:00Z');
  });

  it("the handover ignores the lead's last in-character message instead of answering it", async () => {
    // The live failure: the lead's last demo message was a question ("¿debo ir
    // preparada?") and the model answered it, so the demo just... stopped being a demo.
    vi.mocked(q.getConversationPersona)
      .mockResolvedValueOnce(demoPersona)
      .mockResolvedValue({ activeRole: 'closer', roleStartedAt: '2026-07-30T14:29:29Z', demoStartedAt: null, promptVariant: null, reactivationRound: 0 });
    vi.mocked(q.getActiveDemoSession).mockResolvedValue(session() as never);
    vi.mocked(q.firstInboundAfter).mockResolvedValue('2026-07-30T14:01:00Z');
    vi.mocked(q.countBotMessagesSince).mockResolvedValue(15);
    const agent = agentReplying('respuesta del modelo que NO debe salir');
    await handleInboundWebhook({ ...inbound, body: '¿debo ir preparada?' }, agent);

    expect(agent.generate).not.toHaveBeenCalled();
    const sent = ghl.sendMessage.mock.calls.map((c) => (c[0] as { text: string }).text).join('\n');
    expect(sent).not.toContain('respuesta del modelo');
    expect(sent).toContain('Hasta aquí llega la demo');
  });

  it('the handover still respects a human takeover mid-turn', async () => {
    vi.mocked(q.getConversationPersona)
      .mockResolvedValueOnce(demoPersona)
      .mockResolvedValue({ activeRole: 'closer', roleStartedAt: '2026-07-29T12:00:00Z', demoStartedAt: null, promptVariant: null, reactivationRound: 0 });
    vi.mocked(q.getActiveDemoSession).mockResolvedValue(session() as never);
    vi.mocked(q.countBotMessagesSince).mockResolvedValue(15);
    vi.mocked(q.isHumanActive).mockResolvedValue(true);
    await handleInboundWebhook(inbound, agentReplying());
    expect(ghl.sendMessage).not.toHaveBeenCalled();
  });
});

describe('handleInboundWebhook — the closer persists after the demo (active_role=closer)', () => {
  const closerPersona = { activeRole: 'closer', roleStartedAt: '2026-07-30T15:58:39Z', demoStartedAt: null, promptVariant: null, reactivationRound: 0 };
  const lastSession = {
    leadData: { businessName: 'BeautyFull', businessType: 'Med spa', leadName: 'Leo', services: ['HydraFacial'] },
    endReason: 'exhausted',
    endedAt: '2026-07-30T15:58:55Z',
    booked: true,
  };
  const turnFrom = (agent: Agent) => {
    const call = vi.mocked(agent.generate).mock.calls[0] as unknown as [unknown, { requestContext: { get(k: string): unknown } }];
    return call[1].requestContext.get('turn') as { activeRole?: string; demoHandoff?: Record<string, unknown> };
  };
  const modelMessages = (agent: Agent) =>
    (vi.mocked(agent.generate).mock.calls[0] as unknown as [{ role: string; content: string }[], unknown])[0];

  it('rebuilds the handoff context on EVERY later turn, not just the flip turn', async () => {
    vi.mocked(q.getConversationPersona).mockResolvedValue(closerPersona);
    vi.mocked(q.getLatestDemoSession).mockResolvedValue(lastSession as never);
    const agent = agentReplying();
    await handleInboundWebhook(inbound, agent);
    expect(turnFrom(agent).demoHandoff).toMatchObject({
      reason: 'exhausted', businessName: 'BeautyFull', leadName: 'Leo', booked: true,
    });
    // Not a demo: the demo guards must stay off (follow-ups, classifier, real tools).
    expect(turnFrom(agent).activeRole).toBe('closer');
    expect(q.getActiveDemoSession).not.toHaveBeenCalled();
  });

  it('keeps the closer own replies in history but strips the demo roleplay tail', async () => {
    vi.mocked(q.getConversationPersona).mockResolvedValue(closerPersona);
    vi.mocked(q.getLatestDemoSession).mockResolvedValue(lastSession as never);
    vi.mocked(q.loadRecentMessages).mockResolvedValue([
      { direction: 'inbound',  senderType: 'lead', content: 'Va!',                     sentAt: '2026-07-30T15:58:39Z' },
      { direction: 'outbound', senderType: 'bot',  content: 'TAIL DE LA DEMO',         sentAt: '2026-07-30T15:58:50Z' },
      { direction: 'outbound', senderType: 'bot',  content: 'Hasta aquí llega la demo', sentAt: '2026-07-30T15:59:10Z' },
      { direction: 'inbound',  senderType: 'lead', content: 'ah ok, sí me serviría',   sentAt: '2026-07-30T16:00:00Z' },
    ]);
    const agent = agentReplying();
    await handleInboundWebhook(inbound, agent);
    const dump = JSON.stringify(modelMessages(agent));
    expect(dump).not.toContain('TAIL DE LA DEMO');       // sent before ended_at → roleplay
    expect(dump).toContain('Hasta aquí llega la demo');  // sent after → the closer's own
    expect(dump).toContain('ah ok, sí me serviría');
  });

  it('a closer turn with no session on file still answers (degrades to the normal persona)', async () => {
    vi.mocked(q.getConversationPersona).mockResolvedValue(closerPersona);
    vi.mocked(q.getLatestDemoSession).mockResolvedValue(null);
    const agent = agentReplying();
    const res = await handleInboundWebhook(inbound, agent);
    expect(res.body).toMatchObject({ replied: true });
    expect(turnFrom(agent).demoHandoff).toBeUndefined();
  });

  it('follow-ups re-arm in closer mode (they are only off during the demo)', async () => {
    vi.mocked(q.loadTenantConfig).mockResolvedValue(
      tenant({ config: { ...tenant().config, followUpCadence: [30] } }),
    );
    vi.mocked(q.getConversationPersona).mockResolvedValue(closerPersona);
    vi.mocked(q.getLatestDemoSession).mockResolvedValue(lastSession as never);
    await handleInboundWebhook(inbound, agentReplying());
    expect(q.scheduleFollowUp).toHaveBeenCalledWith('cv-uuid', 1, 30, 'America/Mexico_City', undefined, 'cadence', 0);
  });
});

describe('handleInboundWebhook — the demo START announcement is deterministic', () => {
  // The normal persona is speaking and startDemo creates a session mid-turn. The rules of
  // the game must ride on THAT reply: ad leads arrive not knowing what a demo is, and the
  // ones who found out too late spent it interrogating a roleplayed receptionist.
  const normalPersona = { activeRole: null, roleStartedAt: null, demoStartedAt: null, promptVariant: null, reactivationRound: 0 };
  const created = {
    id: 'sess-new', activatedAt: '2026-07-31T16:00:00Z', expiresAt: '2099-01-01T00:00:00Z',
    messageBudget: 7, personaVersion: 3,
    leadData: { businessName: 'Clínica Sonrisa', businessType: 'clínica dental' },
    promptOverrides: { identity: 'P' }, simulatedBooking: null,
  };
  const sentText = () => ghl.sendMessage.mock.calls.map((c) => (c[0] as { text: string }).text).join('\n');

  beforeEach(() => {
    vi.mocked(q.getConversationPersona).mockResolvedValue(normalPersona);
    vi.mocked(q.loadTenantConfig).mockResolvedValue(
      tenant({ demoSessionsEnabled: true, demoOffKeywords: ['demo off'] }),
    );
  });

  // With a normal persona the turn-start read never happens (it is gated on
  // activeRole === 'demo'), so the ONLY call is the post-generate one.
  it('states who answers next and the way out', async () => {
    vi.mocked(q.getActiveDemoSession).mockResolvedValue(created as never);
    await handleInboundWebhook(inbound, agentReplying('Va, ya lo estoy armando.'));

    const sent = sentText();
    expect(sent).toContain('ya no te respondo yo');              // who answers next
    expect(sent).toContain('para Clínica Sonrisa');              // whose assistant it is
    expect(sent).toContain('Escribe "demo off"');                // the way out, from config
  });

  it('REPLACES the model\'s text — the announcement is never said twice', async () => {
    // Carlos Moreno, 2026-08-01: the prompt forbids the model writing this ("NO escribas
    // tú el aviso… el sistema lo manda solo") and it wrote one anyway on 2 of 2 demos, so
    // the lead was told twice. The model's version is dropped, not appended to.
    vi.mocked(q.getActiveDemoSession).mockResolvedValue(created as never);
    await handleInboundWebhook(
      inbound,
      agentReplying('Listo, Carlos — ahora tu asistente demo te va a responder. Escríbele como si fueras un cliente.'),
    );
    const sent = sentText();
    expect(sent).not.toContain('Listo, Carlos');
    expect(sent).toContain('ya no te respondo yo');
  });

  it('goes out as TWO messages, not a four-message burst', async () => {
    vi.mocked(q.getActiveDemoSession).mockResolvedValue(created as never);
    await handleInboundWebhook(inbound, agentReplying('Va, ya lo estoy armando.'));
    // 4 paragraphs hit MAX_MESSAGE_PARTS exactly and the overflow merge glued the last
    // two together mid-thought. Two paragraphs leaves headroom and reads as one beat.
    expect(ghl.sendMessage).toHaveBeenCalledTimes(2);
  });

  it('no session created → nothing is appended (an ordinary turn stays ordinary)', async () => {
    vi.mocked(q.getActiveDemoSession).mockResolvedValue(null);
    await handleInboundWebhook(inbound, agentReplying('¿A qué se dedica tu negocio?'));
    expect(sentText()).not.toContain('ya no te respondo yo');
  });

  it('a tenant with no off-keyword gets the announcement without a dead exit word', async () => {
    vi.mocked(q.loadTenantConfig).mockResolvedValue(
      tenant({ demoSessionsEnabled: true, demoOffKeywords: null }),
    );
    vi.mocked(q.getActiveDemoSession).mockResolvedValue(created as never);
    await handleInboundWebhook(inbound, agentReplying('Listo.'));
    const sent = sentText();
    expect(sent).toContain('ya no te respondo yo');
    expect(sent).not.toContain('salir de la demo');
  });

  it('a tenant without demo sessions never pays for the check', async () => {
    vi.mocked(q.loadTenantConfig).mockResolvedValue(tenant({ demoSessionsEnabled: false }));
    await handleInboundWebhook(inbound, agentReplying('¿Te agendo el sábado?'));
    expect(q.getActiveDemoSession).not.toHaveBeenCalled();
  });

  it('a session read failure never blocks the reply', async () => {
    vi.mocked(q.getActiveDemoSession).mockRejectedValue(new Error('db down'));
    await handleInboundWebhook(inbound, agentReplying('Va, ya lo estoy armando.'));
    expect(sentText()).toContain('Va, ya lo estoy armando.');
  });
});

describe('handleInboundWebhook — booking ends the demo (objective met)', () => {
  const demoPersona = { activeRole: 'demo', roleStartedAt: '2026-07-30T16:00:00Z', demoStartedAt: '2026-07-30T16:00:00Z', promptVariant: null, reactivationRound: 0 };
  const base = {
    id: 'sess-9', activatedAt: '2026-07-30T16:00:00Z', expiresAt: '2099-01-01T00:00:00Z',
    messageBudget: 7, personaVersion: 3,
    leadData: { businessName: 'BeautyFull', leadName: 'Leo' },
    promptOverrides: { identity: 'P' }, simulatedBooking: null,
  };
  const booking = { startTime: '2026-08-01T17:00:00.000Z', serviceName: 'Botox', label: 'sábado 1 de agosto, 10:00 a.m.' };
  const sentText = () => ghl.sendMessage.mock.calls.map((c) => (c[0] as { text: string }).text).join('\n');

  beforeEach(() => {
    vi.mocked(q.getConversationPersona).mockResolvedValue(demoPersona);
    vi.mocked(q.firstInboundAfter).mockResolvedValue('2026-07-30T16:01:00Z');
    vi.mocked(q.countBotMessagesSince).mockResolvedValue(2); // budget nowhere near spent
  });

  it('a booking made during the turn ends the session as "booked" and appends the pitch', async () => {
    vi.mocked(q.getActiveDemoSession)
      .mockResolvedValueOnce(base as never)                              // turn start: no booking yet
      .mockResolvedValue({ ...base, simulatedBooking: booking } as never); // post-generate: booked
    await handleInboundWebhook(inbound, agentReplying('¡Listo! Nos vemos el sábado a las 10:00 a.m.'));

    expect(q.endDemoSession).toHaveBeenCalledWith('sess-9', 'booked');
    expect(q.logBotEvent).toHaveBeenCalledWith('client1', 'conv1', 'demo_session_ended',
      expect.objectContaining({ reason: 'booked' }));
    const sent = sentText();
    expect(sent).toContain('¡Listo! Nos vemos el sábado');   // the confirmation still goes out
    expect(sent).toContain('Acabas de agendar en menos de un minuto'); // pitch rides on it
    expect(sent).toContain('24/7');
    expect(ghl.addContactTags).toHaveBeenCalledWith('c1', ['demo-completada']);
  });

  it('no booking → the demo continues untouched', async () => {
    vi.mocked(q.getActiveDemoSession).mockResolvedValue(base as never);
    await handleInboundWebhook(inbound, agentReplying('¿Te muestro horarios?'));
    expect(q.endDemoSession).not.toHaveBeenCalled();
    expect(sentText()).not.toContain('Acabas de agendar');
  });

  it('a booking that already existed at turn start does NOT re-end the session', async () => {
    vi.mocked(q.getActiveDemoSession).mockResolvedValue({ ...base, simulatedBooking: booking } as never);
    await handleInboundWebhook(inbound, agentReplying('Nos vemos el sábado.'));
    expect(q.endDemoSession).not.toHaveBeenCalled();
  });

  it('follow-ups re-arm on the booking turn (the demo is over)', async () => {
    vi.mocked(q.loadTenantConfig).mockResolvedValue(
      tenant({ config: { ...tenant().config, followUpCadence: [30] } }),
    );
    vi.mocked(q.getActiveDemoSession)
      .mockResolvedValueOnce(base as never)
      .mockResolvedValue({ ...base, simulatedBooking: booking } as never);
    await handleInboundWebhook(inbound, agentReplying('¡Listo!'));
    expect(q.scheduleFollowUp).toHaveBeenCalledWith('cv-uuid', 1, 30, 'America/Mexico_City', undefined, 'cadence', 0);
  });

  it('a failed session read never breaks the turn — the demo just runs on', async () => {
    vi.mocked(q.getActiveDemoSession)
      .mockResolvedValueOnce(base as never)
      .mockRejectedValue(new Error('db down'));
    const res = await handleInboundWebhook(inbound, agentReplying('¡Listo!'));
    expect(res.body).toMatchObject({ replied: true });
    expect(q.endDemoSession).not.toHaveBeenCalled();
  });
});

describe('handleInboundWebhook — a transient failure must not silence a lead', () => {
  it('duplicate webhook + unanswered lead → recovers and runs the turn', async () => {
    // GHL retried because our first attempt died AFTER storing the inbound. Dedup used to
    // swallow the retry; the lead was never answered (2026-07-30, Facebook).
    vi.mocked(q.logMessage).mockResolvedValueOnce({ conversationId: null, messageId: null });
    vi.mocked(q.findUnansweredInbound).mockResolvedValue({ conversationId: 'cv-uuid', messageId: 'msg-uuid' });
    const agent = agentReplying();
    const res = await handleInboundWebhook(inbound, agent);

    expect(q.logBotEvent).toHaveBeenCalledWith('client1', 'conv1', 'turn_scheduled',
      expect.objectContaining({ via: 'duplicate-recovery' }));
    expect(agent.generate).toHaveBeenCalled();
    expect(ghl.sendMessage).toHaveBeenCalled();
    expect(res.body).toMatchObject({ replied: true });
  });

  it('duplicate webhook on an already-answered thread → still ignored (no double reply)', async () => {
    vi.mocked(q.logMessage).mockResolvedValueOnce({ conversationId: null, messageId: null });
    vi.mocked(q.findUnansweredInbound).mockResolvedValue(null);
    const agent = agentReplying();
    const res = await handleInboundWebhook(inbound, agent);
    expect(agent.generate).not.toHaveBeenCalled();
    expect(res.body).toMatchObject({ ignored: 'duplicate message' });
  });

  it('a failing recovery check degrades to the old behaviour, never throws', async () => {
    vi.mocked(q.logMessage).mockResolvedValueOnce({ conversationId: null, messageId: null });
    vi.mocked(q.findUnansweredInbound).mockRejectedValue(new Error('db down'));
    const res = await handleInboundWebhook(inbound, agentReplying());
    expect(res.body).toMatchObject({ ignored: 'duplicate message' });
  });

  it('the keyword gate fails OPEN when its RPC errors, and says so', async () => {
    vi.mocked(q.loadTenantConfig).mockResolvedValue(tenant({ triggerKeywords: ['agente'] }));
    vi.mocked(q.botActivation).mockRejectedValue(new Error('rpc timeout'));
    const agent = agentReplying();
    const res = await handleInboundWebhook(inbound, agent); // body "hola" — no keyword

    expect(agent.generate).toHaveBeenCalled(); // answered rather than silently dropped
    expect(res.body).toMatchObject({ replied: true });
    expect(q.logBotEvent).toHaveBeenCalledWith('client1', 'conv1', 'db_error',
      expect.objectContaining({ stage: 'bot_activation', failedOpen: true }));
  });

  it('a healthy gate still blocks a keywordless first message', async () => {
    vi.mocked(q.loadTenantConfig).mockResolvedValue(tenant({ triggerKeywords: ['agente'] }));
    vi.mocked(q.botActivation).mockResolvedValue('gated');
    const agent = agentReplying();
    const res = await handleInboundWebhook(inbound, agent);
    expect(agent.generate).not.toHaveBeenCalled();
    expect(res.body).toMatchObject({ ignored: 'trigger keyword required' });
  });
});

describe('handleInboundWebhook — voice notes and images (0046)', () => {
  const voice = { ...inbound, body: '', attachments: ['https://x.test/a/44bbff3b.ogg'], messageId: 'gm-1' };
  const photo = { ...inbound, body: '', attachments: ['https://x.test/p.jpg'], messageId: 'gm-2' };

  it('a voice note is STORED (it used to be dropped before anything was written)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => 'x' }));
    await handleInboundWebhook(voice, agentReplying());
    expect(q.logMessage).toHaveBeenCalledWith(expect.objectContaining({
      p_direction: 'inbound',
      p_sender_type: 'lead',
      p_content: '[nota de voz]',                       // never a blank turn
      p_attachments: ['https://x.test/a/44bbff3b.ogg'],
    }));
  });

  it('transcribes it and writes the text back over the placeholder', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, headers: { get: () => '2048' }, blob: async () => new Blob(['x']) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ text: 'Sí, agendan citas', duration: 3.2 }) });
    vi.stubGlobal('fetch', fetchMock);

    await handleInboundWebhook(voice, agentReplying());

    expect(q.setMessageContent).toHaveBeenCalledWith('msg-uuid', 'Sí, agendan citas');
    expect(q.logBotEvent).toHaveBeenCalledWith('client1', 'conv1', 'attachment_received',
      expect.objectContaining({ kind: 'audio', transcribed: true }));
  });

  it('a caption sent with the audio is kept alongside the transcription', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ ok: true, headers: { get: () => '2048' }, blob: async () => new Blob(['x']) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ text: 'sí agendan' }) }));
    await handleInboundWebhook({ ...voice, body: 'mira' }, agentReplying());
    expect(q.setMessageContent).toHaveBeenCalledWith('msg-uuid', 'mira\nsí agendan');
  });

  it('a failed transcription still answers the lead, and says so in the events', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 502, text: async () => 'bad gateway' }));
    const agent = agentReplying();
    const res = await handleInboundWebhook(voice, agent);

    expect(q.setMessageContent).not.toHaveBeenCalled();
    expect(q.logBotEvent).toHaveBeenCalledWith('client1', 'conv1', 'attachment_failed',
      expect.objectContaining({ kind: 'audio' }));
    expect(agent.generate).toHaveBeenCalled();   // the turn is NOT lost
    expect(res.body).toMatchObject({ replied: true });
  });

  it('an image is stored and flagged, without pretending we read it', async () => {
    await handleInboundWebhook(photo, agentReplying());
    expect(q.logMessage).toHaveBeenCalledWith(expect.objectContaining({
      p_content: '[imagen]', p_attachments: ['https://x.test/p.jpg'],
    }));
    expect(q.logBotEvent).toHaveBeenCalledWith('client1', 'conv1', 'attachment_received',
      expect.objectContaining({ kind: 'image', transcribed: false }));
    expect(q.setMessageContent).not.toHaveBeenCalled();
  });

  it('media cancels the follow-up cadence like any other inbound', async () => {
    // The second-order damage on 2026-08-01: the drop meant cancelFollowUps never ran,
    // so the cron kept nudging a lead who had already answered.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => '' }));
    await handleInboundWebhook(voice, agentReplying());
    expect(q.cancelFollowUps).toHaveBeenCalledWith('cv-uuid');
  });

  it('a text-only message never touches the transcription path', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await handleInboundWebhook(inbound, agentReplying());
    expect(fetchMock).not.toHaveBeenCalled();
    expect(q.logMessage).toHaveBeenCalledWith(expect.objectContaining({ p_attachments: null }));
  });
});

describe('runAgentTurn — resume after the human pause (0053)', () => {
  // A lead message that lands while a human has the thread paused used to be dropped for
  // good once the debounce alarm saw the pause (MADI 2026-08-05: 19h of silence on an
  // active lead). The suppressed run now hands the pause expiry back so the DO re-runs the
  // turn then, flagged `resumed` — and a resumed turn must not answer a message someone
  // already answered, nor one that asks for nothing.
  const PAUSE_ENDS = '2026-08-25T10:30:00.000Z';
  const parsedInbound = () => ({
    locationId: 'loc1', contactId: 'c1', conversationId: 'conv1', channel: 'whatsapp' as const,
    text: 'Gracias', phone: '+521', attachments: [],
  });
  const run = (agent: Agent, resumed: boolean) =>
    runAgentTurn({ agent, conversationId: 'cv-uuid', messageId: 'msg-uuid', tenant: tenant(), parsed: parsedInbound(), phone: '+521', debounced: false, resumed });

  const tail = [
    { direction: 'inbound', senderType: 'lead', content: '¿Cuánto cuesta?', sentAt: '' },
    { direction: 'outbound', senderType: 'human_agent', content: '$500', sentAt: '' },
    { direction: 'inbound', senderType: 'lead', content: 'Gracias', sentAt: '' },
  ] as Awaited<ReturnType<typeof q.loadRecentMessages>>;

  const stubResumeGate = (needsReply: boolean | 'error') => {
    const fetchMock = vi.fn().mockResolvedValue(
      needsReply === 'error'
        ? { ok: false, status: 500, json: async () => ({}) }
        : { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ needs_reply: needsReply }) } }] }) },
    );
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  };

  beforeEach(() => {
    vi.mocked(q.getHumanActiveUntil).mockResolvedValue(null);
    vi.mocked(q.hasReplyAfter).mockResolvedValue(false);
    vi.mocked(q.loadRecentMessages).mockResolvedValue(tail);
  });

  it('suppressed by the sliding pause → returns the expiry so the DO can retry then', async () => {
    vi.mocked(q.isBotSuppressed).mockResolvedValue(true);
    vi.mocked(q.getHumanActiveUntil).mockResolvedValue(PAUSE_ENDS);
    const agent = agentReplying();

    const res = await run(agent, false);

    expect(agent.generate).not.toHaveBeenCalled();
    expect(res.body).toMatchObject({ resumeAt: PAUSE_ENDS });
    expect(q.logBotEvent).toHaveBeenCalledWith('client1', 'conv1', 'run_suppressed',
      expect.objectContaining({ stage: 'pre_generate', resumeAt: PAUSE_ENDS }));
  });

  it('suppressed by a permanent mute (handed_off / opted_out) → no expiry, nothing to retry', async () => {
    vi.mocked(q.isBotSuppressed).mockResolvedValue(true);
    const res = await run(agentReplying(), false);
    expect(res.body).not.toHaveProperty('resumeAt');
  });

  it('a failing expiry read still suppresses — it just cannot promise a retry', async () => {
    vi.mocked(q.isBotSuppressed).mockResolvedValue(true);
    vi.mocked(q.getHumanActiveUntil).mockRejectedValue(new Error('db down'));
    const res = await run(agentReplying(), false);
    expect(res.body).toMatchObject({ ignored: expect.stringContaining('suppressed') });
    expect(res.body).not.toHaveProperty('resumeAt');
  });

  it('resumed + someone already answered → silent, no model call at all', async () => {
    vi.mocked(q.hasReplyAfter).mockResolvedValue(true);
    const fetchMock = stubResumeGate(true);
    const agent = agentReplying();

    const res = await run(agent, true);

    expect(agent.generate).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(ghl.sendMessage).not.toHaveBeenCalled();
    expect(res.body).toMatchObject({ skipped: 'answered' });
    expect(q.logBotEvent).toHaveBeenCalledWith('client1', 'conv1', 'resume_skipped', { reason: 'answered' });
  });

  it('resumed + the last message needs no reply ("Gracias") → silent, with the reason on record', async () => {
    stubResumeGate(false);
    const agent = agentReplying();

    const res = await run(agent, true);

    expect(agent.generate).not.toHaveBeenCalled();
    expect(ghl.sendMessage).not.toHaveBeenCalled();
    expect(res.body).toMatchObject({ skipped: 'no_reply_needed' });
    expect(q.logBotEvent).toHaveBeenCalledWith('client1', 'conv1', 'resume_skipped', { reason: 'no_reply_needed' });
  });

  it('resumed + the last message still asks for something → the normal turn runs and replies', async () => {
    stubResumeGate(true);
    const agent = agentReplying();

    const res = await run(agent, true);

    expect(agent.generate).toHaveBeenCalledOnce();
    expect(ghl.sendMessage).toHaveBeenCalled();
    expect(res.body).toMatchObject({ replied: true });
    expect(q.logBotEvent).not.toHaveBeenCalledWith('client1', 'conv1', 'resume_skipped', expect.anything());
  });

  it('resumed + the classifier fails → replies (silence on a real question is the costlier mistake)', async () => {
    stubResumeGate('error');
    const agent = agentReplying();

    await run(agent, true);

    expect(agent.generate).toHaveBeenCalledOnce();
    expect(ghl.sendMessage).toHaveBeenCalled();
  });

  it('resumed but the pause was extended meanwhile → suppressed again with the new expiry', async () => {
    vi.mocked(q.isBotSuppressed).mockResolvedValue(true);
    vi.mocked(q.getHumanActiveUntil).mockResolvedValue(PAUSE_ENDS);
    const fetchMock = stubResumeGate(true);

    const res = await run(agentReplying(), true);

    expect(res.body).toMatchObject({ resumeAt: PAUSE_ENDS });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('an ordinary (non-resumed) turn never runs the resume gate', async () => {
    const fetchMock = stubResumeGate(false);
    const agent = agentReplying();

    await run(agent, false);

    expect(q.hasReplyAfter).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(agent.generate).toHaveBeenCalledOnce();
  });
});
