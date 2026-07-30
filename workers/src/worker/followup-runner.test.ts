import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Agent } from '@mastra/core/agent';
import type { TenantContext } from '../core/types.js';
import type { DueFollowUp } from '../db/types.js';

vi.mock('../core/env.js');
vi.mock('../db/queries.js');
vi.mock('../core/runtime-context.js', () => ({ buildAgentRequestContext: vi.fn(() => ({})) }));
vi.mock('../roles/reactivation/angle-select.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../roles/reactivation/angle-select.js')>();
  // Keep the PURE pool resolver real; stub only the model-output parser.
  return { ...actual, parseAngleSelection: vi.fn(() => ({ message: 'te esperamos 👋', angleChoice: null })) };
});
const ghl = { sendMessage: vi.fn() };
vi.mock('../ghl/client.js', () => ({ GhlClient: vi.fn(() => ghl) }));

import { getAiApiKey, resolveAiApiKey } from '../core/env.js';
import * as q from '../db/queries.js';
import { runPendingFollowUps } from './followup-runner.js';

function tenant(overrides: Record<string, unknown> = {}): TenantContext {
  return {
    tenantId: 't1',
    clientId: 'client1',
    ghlLocationId: 'loc1',
    config: { followUpCadence: [60, 1440], followUpAngles: ['angle A', 'angle B'], timezone: 'America/Mexico_City', quietHours: null, ...overrides },
  } as unknown as TenantContext;
}

const due = (o: Partial<DueFollowUp> = {}): DueFollowUp => ({
  followUpId: 'fu1',
  conversationId: 'cv1',
  ghlConversationId: 'conv1',
  ghlContactId: 'c1',
  contactPhone: '+521',
  channel: 'whatsapp',
  tier: 1,
  ghlLocationId: 'loc1',
  ...o,
});

const agent = { generate: vi.fn() } as unknown as Agent;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getAiApiKey).mockReturnValue('test-key');
  vi.mocked(resolveAiApiKey).mockReturnValue({ apiKey: 'test-key', source: 'platform', fellBack: false });
  vi.mocked(q.loadDueFollowUps).mockResolvedValue([due()]);
  vi.mocked(q.loadTenantConfig).mockResolvedValue(tenant());
  vi.mocked(q.loadSentAngleIndexes).mockResolvedValue([]);
  vi.mocked(q.loadRecentMessages).mockResolvedValue([]);
  vi.mocked(q.logMessage).mockResolvedValue({ conversationId: 'cv1', messageId: 'msg1' });
  vi.mocked(q.setGhlMessageId).mockResolvedValue(undefined);
  vi.mocked(q.markDelivered).mockResolvedValue(undefined);
  vi.mocked(q.markFollowUpSent).mockResolvedValue(undefined);
  vi.mocked(q.markFollowUpFailed).mockResolvedValue(undefined);
  vi.mocked(q.scheduleFollowUp).mockResolvedValue(null);
  vi.mocked(q.updateConversationStatus).mockResolvedValue(undefined);
  vi.mocked(agent.generate).mockResolvedValue({ text: 'te esperamos 👋' } as never);
  ghl.sendMessage.mockResolvedValue({ ghlMessageId: 'g1' });
});

describe('runPendingFollowUps', () => {
  it('nothing due → no-op', async () => {
    vi.mocked(q.loadDueFollowUps).mockResolvedValue([]);
    expect(await runPendingFollowUps(agent)).toEqual({ processed: 0, failed: 0, skipped: 0 });
    expect(agent.generate).not.toHaveBeenCalled();
  });

  it('unknown tenant → skipped', async () => {
    vi.mocked(q.loadTenantConfig).mockResolvedValue(null);
    expect(await runPendingFollowUps(agent)).toEqual({ processed: 0, failed: 0, skipped: 1 });
  });

  it('tier out of cadence range → skipped', async () => {
    vi.mocked(q.loadDueFollowUps).mockResolvedValue([due({ tier: 5 })]);
    expect(await runPendingFollowUps(agent)).toEqual({ processed: 0, failed: 0, skipped: 1 });
  });

  it('happy path → sends, marks sent, schedules the next tier', async () => {
    const res = await runPendingFollowUps(agent);
    expect(ghl.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ contactId: 'c1', text: 'te esperamos 👋' }));
    expect(q.markFollowUpSent).toHaveBeenCalledWith('fu1', expect.anything());
    expect(q.scheduleFollowUp).toHaveBeenCalledWith('cv1', 2, 1440, 'America/Mexico_City', null);
    expect(q.updateConversationStatus).not.toHaveBeenCalled();
    expect(res).toEqual({ processed: 1, failed: 0, skipped: 0 });
  });

  it('last tier exhausted → conversation set to standby (the freno)', async () => {
    vi.mocked(q.loadTenantConfig).mockResolvedValue(tenant({ followUpCadence: [60] }));
    const res = await runPendingFollowUps(agent);
    expect(q.scheduleFollowUp).not.toHaveBeenCalled();
    expect(q.updateConversationStatus).toHaveBeenCalledWith('conv1', 'standby');
    expect(res.processed).toBe(1);
  });

  it('agent generate fails → marked failed', async () => {
    vi.mocked(agent.generate).mockRejectedValue(new Error('llm 500'));
    const res = await runPendingFollowUps(agent);
    expect(q.markFollowUpFailed).toHaveBeenCalledWith('fu1');
    expect(res).toEqual({ processed: 0, failed: 1, skipped: 0 });
  });
});

describe('runPendingFollowUps — campaign-aware angle pools', () => {
  // buildAgentRequestContext is mocked at module level; assert the candidates it receives.
  const candidatesArg = async () => {
    const { buildAgentRequestContext } = await import('../core/runtime-context.js');
    return (vi.mocked(buildAgentRequestContext).mock.calls[0]?.[0] as { reactivationCandidates?: string[] }).reactivationCandidates;
  };

  const variantTenant = () =>
    tenant({
      followUpAngles: ['angle A', 'angle B'],
      promptVariants: { 'laser-promo': { followUpAngles: ['promo laser angle'] } },
    });

  it('a variant-pinned conversation nudges from the variant pool', async () => {
    vi.mocked(q.loadTenantConfig).mockResolvedValue(variantTenant());
    vi.mocked(q.getConversationPersona).mockResolvedValue({ activeRole: null, roleStartedAt: null, demoStartedAt: null, promptVariant: 'laser-promo' });
    await runPendingFollowUps(agent);
    expect(await candidatesArg()).toEqual(['promo laser angle']);
  });

  it('no pinned variant → tenant pool', async () => {
    vi.mocked(q.loadTenantConfig).mockResolvedValue(variantTenant());
    vi.mocked(q.getConversationPersona).mockResolvedValue({ activeRole: null, roleStartedAt: null, demoStartedAt: null, promptVariant: null });
    await runPendingFollowUps(agent);
    expect(await candidatesArg()).toEqual(['angle A', 'angle B']);
  });

  it('a persona read failure falls back to the tenant pool, follow-up still sends', async () => {
    vi.mocked(q.loadTenantConfig).mockResolvedValue(variantTenant());
    vi.mocked(q.getConversationPersona).mockRejectedValue(new Error('db down'));
    const res = await runPendingFollowUps(agent);
    expect(await candidatesArg()).toEqual(['angle A', 'angle B']);
    expect(res.processed).toBe(1);
  });
});

describe('runPendingFollowUps — post-demo nudges (the roleplay must not leak)', () => {
  const ctxArg = async () => {
    const { buildAgentRequestContext } = await import('../core/runtime-context.js');
    return vi.mocked(buildAgentRequestContext).mock.calls[0]?.[0] as {
      demoContext?: { businessName?: string; booked?: boolean };
    };
  };

  it('a closer conversation loads history from the persona flip, not the whole roleplay', async () => {
    vi.mocked(q.getConversationPersona).mockResolvedValue({
      activeRole: 'closer', roleStartedAt: '2026-07-30T17:55:00Z', demoStartedAt: null, promptVariant: null,
    });
    vi.mocked(q.getLatestDemoSession).mockResolvedValue({
      leadData: { businessName: 'BeautyFull' }, endReason: 'booked', endedAt: '2026-07-30T17:55:00Z', booked: true,
    } as never);
    await runPendingFollowUps(agent);
    expect(q.loadRecentMessages).toHaveBeenCalledWith('cv1', 20, '2026-07-30T17:55:00Z');
  });

  it('passes the demo context so the nudge never chases the simulated appointment', async () => {
    vi.mocked(q.getConversationPersona).mockResolvedValue({
      activeRole: 'closer', roleStartedAt: '2026-07-30T17:55:00Z', demoStartedAt: null, promptVariant: null,
    });
    vi.mocked(q.getLatestDemoSession).mockResolvedValue({
      leadData: { businessName: 'BeautyFull' }, endReason: 'booked', endedAt: null, booked: true,
    } as never);
    await runPendingFollowUps(agent);
    expect((await ctxArg()).demoContext).toEqual({ businessName: 'BeautyFull', booked: true });
  });

  it('a normal (non-demo) conversation is untouched: full history, no demo context', async () => {
    vi.mocked(q.getConversationPersona).mockResolvedValue({
      activeRole: null, roleStartedAt: null, demoStartedAt: null, promptVariant: null,
    });
    await runPendingFollowUps(agent);
    expect(q.loadRecentMessages).toHaveBeenCalledWith('cv1', 20, undefined);
    expect((await ctxArg()).demoContext).toBeUndefined();
    expect(q.getLatestDemoSession).not.toHaveBeenCalled();
  });

  it('a failed demo-context read still sends the nudge', async () => {
    vi.mocked(q.getConversationPersona).mockResolvedValue({
      activeRole: 'closer', roleStartedAt: '2026-07-30T17:55:00Z', demoStartedAt: null, promptVariant: null,
    });
    vi.mocked(q.getLatestDemoSession).mockRejectedValue(new Error('db down'));
    const res = await runPendingFollowUps(agent);
    expect(res.processed).toBe(1);
  });
});
