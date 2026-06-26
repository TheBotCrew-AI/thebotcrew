import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Agent } from '@mastra/core/agent';
import type { TenantContext } from '../core/types.js';

// ── Mock the seams: DB, GHL transport, env. No DB, no network, no model. ──────
const ghl = {
  getContactPhone: vi.fn(),
  sendMessage: vi.fn(),
  addContactTags: vi.fn(),
};
vi.mock('../ghl/client.js', () => ({ GhlClient: vi.fn(() => ghl) }));
vi.mock('../core/env.js');
vi.mock('../db/queries.js');

import * as q from '../db/queries.js';
import { getAiApiKey } from '../core/env.js';
import { handleInboundWebhook } from './webhook-handler.js';

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
  vi.mocked(getAiApiKey).mockReturnValue('test-key');
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
  ghl.getContactPhone.mockResolvedValue(undefined);
  ghl.sendMessage.mockResolvedValue({ ghlMessageId: 'out-ghl-1' });
  ghl.addContactTags.mockResolvedValue(undefined);
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
