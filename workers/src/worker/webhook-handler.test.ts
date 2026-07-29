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

import * as q from '../db/queries.js';
import { getAiApiKey, resolveAiApiKey } from '../core/env.js';
import { handleInboundWebhook, splitIntoMessages } from './webhook-handler.js';

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
  vi.mocked(q.setGhlMessageId).mockResolvedValue(undefined);
  vi.mocked(q.markDelivered).mockResolvedValue(undefined);
  vi.mocked(q.updateConversationStatus).mockResolvedValue(undefined);
  vi.mocked(q.botActivation).mockResolvedValue('already');
  vi.mocked(q.setConversationContactKeys).mockResolvedValue(undefined);
  vi.mocked(q.getConversationContactKeys).mockResolvedValue({ phone: null, email: null });
  vi.mocked(q.updateConversationContact).mockResolvedValue(undefined);
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
        model: 'gpt-5-mini',
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

describe('handleInboundWebhook — active appointment guard', () => {
  const turnFrom = (agent: Agent) => {
    const call = vi.mocked(agent.generate).mock.calls[0] as unknown as [
      unknown,
      { requestContext: { get(k: string): unknown } },
    ];
    return call[1].requestContext.get('turn') as { activeAppointment?: { startTime: string; service?: string } };
  };

  it("injects the contact's active appointment into the turn context", async () => {
    vi.mocked(q.loadActiveAppointment).mockResolvedValue({ startTime: '2026-07-04T14:30:00-07:00', service: 'Corte' });
    const agent = agentReplying();
    await handleInboundWebhook(inbound, agent);
    expect(turnFrom(agent).activeAppointment).toEqual({ startTime: '2026-07-04T14:30:00-07:00', service: 'Corte' });
  });

  it('leaves activeAppointment undefined when there is no active appointment', async () => {
    vi.mocked(q.loadActiveAppointment).mockResolvedValue(null);
    const agent = agentReplying();
    await handleInboundWebhook(inbound, agent);
    expect(turnFrom(agent).activeAppointment).toBeUndefined();
  });

  it('skips the appointment lookup in demo mode (clean-start)', async () => {
    vi.mocked(q.getConversationPersona).mockResolvedValue({ activeRole: 'demo', demoStartedAt: null });
    vi.mocked(q.loadActiveAppointment).mockResolvedValue({ startTime: '2026-07-04T14:30:00-07:00', service: 'Corte' });
    const agent = agentReplying();
    await handleInboundWebhook(inbound, agent);
    expect(q.loadActiveAppointment).not.toHaveBeenCalled();
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
