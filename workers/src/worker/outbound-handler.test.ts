import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TenantContext } from '../core/types.js';
import type { ParsedHumanOutbound } from '../ghl/types.js';

vi.mock('../core/tenant.js');
vi.mock('../db/queries.js');
vi.mock('../ghl/webhook.js');
const ghl = { getUser: vi.fn() };
vi.mock('../ghl/client.js', () => ({ GhlClient: vi.fn(() => ghl) }));

import { resolveTenant } from '../core/tenant.js';
import * as q from '../db/queries.js';
import { parseOutboundWebhook } from '../ghl/webhook.js';
import { handleOutboundWebhook } from './outbound-handler.js';

const tenant = { tenantId: 't1', clientId: 'client1', ghlLocationId: 'loc1', config: {} } as unknown as TenantContext;

const parsed = (): ParsedHumanOutbound => ({
  locationId: 'loc1',
  contactId: 'c1',
  conversationId: 'conv1',
  channel: 'whatsapp',
  text: 'hola desde el equipo',
  messageId: 'm1',
  ghlUserId: 'u1',
  source: 'app',
  sentAt: '2026-07-02T10:00:00Z',
  phone: '+521',
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(parseOutboundWebhook).mockReturnValue(parsed());
  vi.mocked(resolveTenant).mockResolvedValue(tenant);
  vi.mocked(q.isBotMessageById).mockResolvedValue(false);
  vi.mocked(q.isRecentBotEcho).mockResolvedValue(false);
  vi.mocked(q.conversationMessageCount).mockResolvedValue(1); // default: mid-thread takeover
  vi.mocked(q.findHumanAgentByGhlId).mockResolvedValue('ha1');
  vi.mocked(q.logMessage).mockResolvedValue({ conversationId: 'cv1', messageId: 'msg1' });
  vi.mocked(q.setHumanActive).mockResolvedValue(undefined);
  vi.mocked(q.cancelFollowUps).mockResolvedValue(undefined);
  vi.mocked(q.upsertHumanAgent).mockResolvedValue('ha-new');
  ghl.getUser.mockResolvedValue({ name: 'Juan', email: 'juan@x.com' });
});

describe('handleOutboundWebhook — filters', () => {
  it('not a human outbound → ignored', async () => {
    vi.mocked(parseOutboundWebhook).mockReturnValue(null);
    const res = await handleOutboundWebhook({} as never);
    expect(res.body).toMatchObject({ ignored: 'not a human agent outbound message' });
    expect(q.logMessage).not.toHaveBeenCalled();
  });

  it('bot echo confirmed by DB id → ignored', async () => {
    vi.mocked(q.isBotMessageById).mockResolvedValue(true);
    const res = await handleOutboundWebhook({} as never);
    expect(res.body).toMatchObject({ ignored: 'bot echo (confirmed by DB)' });
    expect(q.logMessage).not.toHaveBeenCalled();
  });

  it('bot echo matched by content+recency → ignored', async () => {
    vi.mocked(q.isRecentBotEcho).mockResolvedValue(true);
    const res = await handleOutboundWebhook({} as never);
    expect(res.body).toMatchObject({ ignored: 'bot echo (matched by content)' });
    expect(q.logMessage).not.toHaveBeenCalled();
  });

  it('unknown tenant → ignored', async () => {
    vi.mocked(resolveTenant).mockResolvedValue(null);
    const res = await handleOutboundWebhook({} as never);
    expect(res.body).toMatchObject({ ignored: 'unknown or inactive tenant' });
  });

  it('duplicate (logMessage dedup → null messageId) → ignored', async () => {
    vi.mocked(q.logMessage).mockResolvedValue({ conversationId: null, messageId: null });
    const res = await handleOutboundWebhook({} as never);
    expect(res.body).toMatchObject({ ignored: 'duplicate' });
    expect(q.setHumanActive).not.toHaveBeenCalled();
  });
});

describe('handleOutboundWebhook — takeover vs opener', () => {
  it('mid-thread human message → logs + opens default 5-min pause + cancels follow-ups', async () => {
    const res = await handleOutboundWebhook({} as never);

    expect(q.logMessage).toHaveBeenCalledWith(expect.objectContaining({ p_sender_type: 'human_agent', p_content: 'hola desde el equipo' }));
    expect(q.setHumanActive).toHaveBeenCalledWith('conv1', 5);
    expect(q.cancelFollowUps).toHaveBeenCalledWith('cv1');
    expect(res.body).toMatchObject({ logged: true, conversationId: 'cv1' });
  });

  it('tenant with human_pause_minutes → pause uses the configured length', async () => {
    vi.mocked(resolveTenant).mockResolvedValue({
      ...tenant,
      config: { humanPauseMinutes: 30 },
    } as unknown as TenantContext);
    await handleOutboundWebhook({} as never);
    expect(q.setHumanActive).toHaveBeenCalledWith('conv1', 30);
  });

  it('cold-outreach opener (first message) → logs only, NO pause, NO cancel', async () => {
    vi.mocked(q.conversationMessageCount).mockResolvedValue(0);
    const res = await handleOutboundWebhook({} as never);

    expect(q.logMessage).toHaveBeenCalledOnce();
    expect(q.setHumanActive).not.toHaveBeenCalled();
    expect(q.cancelFollowUps).not.toHaveBeenCalled();
    expect(res.body).toMatchObject({ logged: true, opener: true });
  });
});

describe('handleOutboundWebhook — campaign sends (bulk_actions, 0072)', () => {
  const campaign = (): ParsedHumanOutbound => ({ ...parsed(), ghlUserId: undefined, source: 'bulk_actions' });

  it('mid-thread template → logged with no author, nudges cancelled, NO pause, NO GHL user lookup', async () => {
    vi.mocked(parseOutboundWebhook).mockReturnValue(campaign());
    const res = await handleOutboundWebhook({} as never);

    expect(q.logMessage).toHaveBeenCalledWith(expect.objectContaining({ p_sender_type: 'campaign', p_human_agent_id: null }));
    expect(q.cancelFollowUps).toHaveBeenCalledWith('cv1');
    expect(q.setHumanActive).not.toHaveBeenCalled();
    expect(q.findHumanAgentByGhlId).not.toHaveBeenCalled();
    expect(ghl.getUser).not.toHaveBeenCalled();
    expect(res.body).toMatchObject({ logged: true, opener: true, campaign: 'bulk_actions' });
  });

  it('template as the first message → logged, nothing to cancel, NO pause', async () => {
    vi.mocked(parseOutboundWebhook).mockReturnValue(campaign());
    vi.mocked(q.conversationMessageCount).mockResolvedValue(0);
    await handleOutboundWebhook({} as never);

    expect(q.cancelFollowUps).not.toHaveBeenCalled();
    expect(q.setHumanActive).not.toHaveBeenCalled();
  });

  it('duplicate webhook for the same template (GHL fires twice) → dedup, nothing else', async () => {
    vi.mocked(parseOutboundWebhook).mockReturnValue(campaign());
    vi.mocked(q.logMessage).mockResolvedValue({ conversationId: 'cv1', messageId: null } as never);
    const res = await handleOutboundWebhook({} as never);

    expect(q.cancelFollowUps).not.toHaveBeenCalled();
    expect(res.body).toMatchObject({ ignored: 'duplicate' });
  });
});

describe('handleOutboundWebhook — human agent resolution', () => {
  it('agent already in DB → GHL Users API not called', async () => {
    await handleOutboundWebhook({} as never);
    expect(ghl.getUser).not.toHaveBeenCalled();
    expect(q.upsertHumanAgent).not.toHaveBeenCalled();
    expect(q.logMessage).toHaveBeenCalledWith(expect.objectContaining({ p_human_agent_id: 'ha1' }));
  });

  it('agent unknown → fetches from GHL and upserts', async () => {
    vi.mocked(q.findHumanAgentByGhlId).mockResolvedValue(null);
    await handleOutboundWebhook({} as never);
    expect(ghl.getUser).toHaveBeenCalledWith('u1');
    expect(q.upsertHumanAgent).toHaveBeenCalledWith(expect.objectContaining({ p_ghl_user_id: 'u1', p_name: 'Juan', p_email: 'juan@x.com' }));
  });

  it('agent unknown + GHL lookup fails → upserts with placeholder name', async () => {
    vi.mocked(q.findHumanAgentByGhlId).mockResolvedValue(null);
    ghl.getUser.mockResolvedValue(null);
    await handleOutboundWebhook({} as never);
    expect(q.upsertHumanAgent).toHaveBeenCalledWith(expect.objectContaining({ p_name: 'GHL User u1', p_email: null }));
  });
});
