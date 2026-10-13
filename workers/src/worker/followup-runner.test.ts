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
const ghl = { sendMessage: vi.fn(), addContactTags: vi.fn() };
vi.mock('../ghl/client.js', () => ({ GhlClient: vi.fn(() => ghl) }));
// The predicate has its own unit tests (upcoming-appointment.test.ts); here it is a seam.
vi.mock('../db/upcoming-appointment.js', () => ({ findUpcomingAppointment: vi.fn() }));

import { getAiApiKey, resolveAiApiKey } from '../core/env.js';
import { buildAgentRequestContext } from '../core/runtime-context.js';
import { parseAngleSelection } from '../roles/reactivation/angle-select.js';
import * as q from '../db/queries.js';
import { findUpcomingAppointment } from '../db/upcoming-appointment.js';
import { runPendingFollowUps } from './followup-runner.js';

function tenant(overrides: Record<string, unknown> = {}, top: Record<string, unknown> = {}): TenantContext {
  return {
    tenantId: 't1',
    clientId: 'client1',
    ghlLocationId: 'loc1',
    demoOffKeywords: ['salir demo'],
    ...top,
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
  kind: 'cadence',
  lastInboundMessageId: 'in1',
  round: 0,
  stage: null,
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
  vi.mocked(q.loadMediaAssets).mockResolvedValue([]);
  vi.mocked(q.loadRecentMessages).mockResolvedValue([]);
  vi.mocked(q.logMessage).mockResolvedValue({ conversationId: 'cv1', messageId: 'msg1' });
  vi.mocked(q.setGhlMessageId).mockResolvedValue(undefined);
  vi.mocked(q.markDelivered).mockResolvedValue(undefined);
  vi.mocked(q.markFollowUpSent).mockResolvedValue(undefined);
  vi.mocked(q.markFollowUpFailed).mockResolvedValue(undefined);
  vi.mocked(q.scheduleFollowUp).mockResolvedValue(null);
  vi.mocked(q.updateConversationStatus).mockResolvedValue(true);
  // The send gate: open by default so existing cases exercise the happy path.
  vi.mocked(q.getFollowUpStatus).mockResolvedValue('processing');
  vi.mocked(q.commitFollowUpSend).mockResolvedValue(true);
  vi.mocked(q.countSentDemoReminders).mockResolvedValue(0);
  vi.mocked(q.cancelFollowUps).mockResolvedValue(undefined);
  vi.mocked(q.logBotEvent).mockResolvedValue(undefined);
  vi.mocked(q.getActiveDemoSession).mockResolvedValue(null);
  vi.mocked(q.endDemoSession).mockResolvedValue(undefined);
  vi.mocked(q.setActiveRole).mockResolvedValue(undefined);
  vi.mocked(q.getConversationPersona).mockResolvedValue({
    activeRole: null, roleStartedAt: null, demoStartedAt: null, promptVariant: null, reactivationRound: 0, leadTimezone: null, stage: null, interest: null,
  });
  vi.mocked(findUpcomingAppointment).mockResolvedValue(null);
  vi.mocked(q.isBotSuppressed).mockResolvedValue(false);
  vi.mocked(agent.generate).mockResolvedValue({ text: 'te esperamos 👋' } as never);
  ghl.sendMessage.mockResolvedValue({ ghlMessageId: 'g1' });
  ghl.addContactTags.mockResolvedValue(undefined);
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
    expect(q.markFollowUpSent).toHaveBeenCalledWith('fu1', expect.anything(), 'tenant');
    expect(q.scheduleFollowUp).toHaveBeenCalledWith('cv1', 2, 1440, 'America/Mexico_City', null, 'cadence', 0, null);
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

describe('runPendingFollowUps — the send gate (a lead who replies must not be chased)', () => {
  // Regression for 2026-07-31 conv b5bf41b4: the lead answered at 15:29:06 and the
  // nudge still went out at 15:29:14, because nothing re-read the row between the
  // claim and the send — and markFollowUpSent then overwrote 'cancelled' with 'sent'.

  it('the inbound already cancelled the row → aborts BEFORE paying for a generation', async () => {
    vi.mocked(q.getFollowUpStatus).mockResolvedValue('cancelled');
    const res = await runPendingFollowUps(agent);
    expect(agent.generate).not.toHaveBeenCalled();
    expect(ghl.sendMessage).not.toHaveBeenCalled();
    expect(q.markFollowUpSent).not.toHaveBeenCalled();
    expect(res).toEqual({ processed: 0, failed: 0, skipped: 1 });
  });

  it('the lead replies DURING generation → the gate refuses and nothing is sent', async () => {
    vi.mocked(q.commitFollowUpSend).mockResolvedValue(false);
    const res = await runPendingFollowUps(agent);
    expect(agent.generate).toHaveBeenCalled();       // tokens were already spent
    expect(ghl.sendMessage).not.toHaveBeenCalled();  // but the lead is spared
    expect(q.markFollowUpSent).not.toHaveBeenCalled();
    expect(res).toEqual({ processed: 0, failed: 0, skipped: 1 });
  });

  it('an aborted nudge is never logged as an outbound message', async () => {
    vi.mocked(q.commitFollowUpSend).mockResolvedValue(false);
    await runPendingFollowUps(agent);
    expect(q.logMessage).not.toHaveBeenCalled();
  });

  it('an abort is recorded — the silent overwrite is what hid this bug', async () => {
    vi.mocked(q.commitFollowUpSend).mockResolvedValue(false);
    await runPendingFollowUps(agent);
    expect(q.logBotEvent).toHaveBeenCalledWith(
      'client1', 'conv1', 'followup_aborted', expect.objectContaining({ reason: 'lead_replied' }),
    );
    expect(q.cancelFollowUps).toHaveBeenCalledWith('cv1');
  });

  it('the gate is handed the last inbound seen at claim time', async () => {
    await runPendingFollowUps(agent);
    expect(q.commitFollowUpSend).toHaveBeenCalledWith('fu1', 'in1');
  });

  it('a cadence nudge that finds the conversation back in a demo aborts', async () => {
    vi.mocked(q.getConversationPersona).mockResolvedValue({
      activeRole: 'demo', roleStartedAt: null, demoStartedAt: null, promptVariant: null, reactivationRound: 0, leadTimezone: null, stage: null, interest: null,
    });
    const res = await runPendingFollowUps(agent);
    expect(agent.generate).not.toHaveBeenCalled();
    expect(res.skipped).toBe(1);
  });
});

describe('runPendingFollowUps — demo reminders', () => {
  const demoDue = (o: Partial<DueFollowUp> = {}) => due({ kind: 'demo', ...o });
  const sentText = () =>
    ghl.sendMessage.mock.calls.map((c) => (c[0] as { text: string }).text).join('\n');
  const inDemo = () =>
    vi.mocked(q.getConversationPersona).mockResolvedValue({
      activeRole: 'demo', roleStartedAt: null, demoStartedAt: null, promptVariant: null, reactivationRound: 0, leadTimezone: null, stage: null, interest: null,
    });

  beforeEach(() => {
    vi.mocked(q.loadDueFollowUps).mockResolvedValue([demoDue()]);
    inDemo();
  });

  it('never calls the model — the reactivation agent is what breaks the roleplay', async () => {
    await runPendingFollowUps(agent);
    expect(agent.generate).not.toHaveBeenCalled();
    expect(q.loadSentAngleIndexes).not.toHaveBeenCalled();
  });

  it('rung 1 is the "ignore this" nudge, wrapped in parentheses', async () => {
    await runPendingFollowUps(agent);
    const text = sentText();
    expect(text.startsWith('(')).toBe(true);
    expect(text.endsWith(')')).toBe(true);
    expect(text).toContain('sigue activo');
  });

  it('rung 2 names the tenant\'s configured exit keyword, never an invented one', async () => {
    vi.mocked(q.countSentDemoReminders).mockResolvedValue(1);
    await runPendingFollowUps(agent);
    expect(sentText()).toContain('"salir demo"');
  });

  it('with no exit keyword configured it promises nothing instead of naming a dead word', async () => {
    vi.mocked(q.loadTenantConfig).mockResolvedValue(tenant({}, { demoOffKeywords: null }));
    vi.mocked(q.countSentDemoReminders).mockResolvedValue(1);
    await runPendingFollowUps(agent);
    expect(sentText()).not.toContain('Escribe');
  });

  it('the rung follows what was DELIVERED, so an active lead never skips #2', async () => {
    // Row scheduled as tier 1, but one reminder already landed → send #2, not #1.
    vi.mocked(q.countSentDemoReminders).mockResolvedValue(1);
    vi.mocked(q.loadDueFollowUps).mockResolvedValue([demoDue({ tier: 1 })]);
    await runPendingFollowUps(agent);
    expect(sentText()).toContain('terminar el demo');
  });

  it('reminders are attributed so they cannot eat the 7-message demo budget', async () => {
    await runPendingFollowUps(agent);
    expect(q.logMessage).toHaveBeenCalledWith(
      expect.objectContaining({ p_agent_role: 'demo-reminder' }),
    );
  });

  it('they burn no angle — the pool is intact for the closer', async () => {
    await runPendingFollowUps(agent);
    expect(q.markFollowUpSent).toHaveBeenCalledWith('fu1', null, null);
  });

  it('rungs 1 and 2 arm the next rung on the demo ladder', async () => {
    await runPendingFollowUps(agent);
    expect(q.scheduleFollowUp).toHaveBeenCalledWith('cv1', 2, 240, 'America/Mexico_City', null, 'demo', 0, null);
  });

  it('rung 3 closes the session and hands the lead to the closer', async () => {
    vi.mocked(q.countSentDemoReminders).mockResolvedValue(2);
    vi.mocked(q.getActiveDemoSession).mockResolvedValue({ id: 'sess1' } as never);
    await runPendingFollowUps(agent);
    expect(q.endDemoSession).toHaveBeenCalledWith('sess1', 'expired');
    expect(q.setActiveRole).toHaveBeenCalledWith('conv1', 'closer');
    // …and the 44-angle ladder restarts, which is the whole point: before this a
    // lead who walked away mid-demo was unreachable forever.
    expect(q.scheduleFollowUp).toHaveBeenCalledWith('cv1', 1, 60, 'America/Mexico_City', null, 'cadence', 0, null);
  });

  it('the demo ended before the reminder fired → nothing is sent', async () => {
    vi.mocked(q.getConversationPersona).mockResolvedValue({
      activeRole: 'closer', roleStartedAt: null, demoStartedAt: null, promptVariant: null, reactivationRound: 0, leadTimezone: null, stage: null, interest: null,
    });
    const res = await runPendingFollowUps(agent);
    expect(ghl.sendMessage).not.toHaveBeenCalled();
    expect(res.skipped).toBe(1);
  });

  it('the same send gate applies: a lead who replied is not nudged', async () => {
    vi.mocked(q.commitFollowUpSend).mockResolvedValue(false);
    const res = await runPendingFollowUps(agent);
    expect(ghl.sendMessage).not.toHaveBeenCalled();
    expect(res.skipped).toBe(1);
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
    vi.mocked(q.getConversationPersona).mockResolvedValue({ activeRole: null, roleStartedAt: null, demoStartedAt: null, promptVariant: 'laser-promo', reactivationRound: 0, leadTimezone: null, stage: null, interest: null });
    await runPendingFollowUps(agent);
    expect(await candidatesArg()).toEqual(['promo laser angle']);
  });

  it('a variant that opted out of nudges aborts the row instead of sending', async () => {
    vi.mocked(q.loadTenantConfig).mockResolvedValue(
      tenant({ promptVariants: { demo24: { followUpsEnabled: false } } }),
    );
    vi.mocked(q.getConversationPersona).mockResolvedValue({ activeRole: null, roleStartedAt: null, demoStartedAt: null, promptVariant: 'demo24', reactivationRound: 0, leadTimezone: null, stage: null, interest: null });
    await runPendingFollowUps(agent);
    expect(ghl.sendMessage).not.toHaveBeenCalled();
    expect(q.cancelFollowUps).toHaveBeenCalledWith('cv1');
    expect(q.logBotEvent).toHaveBeenCalledWith(
      'client1', 'conv1', 'followup_aborted', expect.objectContaining({ reason: 'variant_no_follow_ups' }),
    );
  });

  it('no pinned variant → tenant pool', async () => {
    vi.mocked(q.loadTenantConfig).mockResolvedValue(variantTenant());
    vi.mocked(q.getConversationPersona).mockResolvedValue({ activeRole: null, roleStartedAt: null, demoStartedAt: null, promptVariant: null, reactivationRound: 0, leadTimezone: null, stage: null, interest: null });
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
      activeRole: 'closer', roleStartedAt: '2026-07-30T17:55:00Z', demoStartedAt: null, promptVariant: null, reactivationRound: 0, leadTimezone: null, stage: null, interest: null,
    });
    vi.mocked(q.getLatestDemoSession).mockResolvedValue({
      leadData: { businessName: 'BeautyFull' }, endReason: 'booked', endedAt: '2026-07-30T17:55:00Z', booked: true,
    } as never);
    await runPendingFollowUps(agent);
    expect(q.loadRecentMessages).toHaveBeenCalledWith('cv1', 20, '2026-07-30T17:55:00Z');
  });

  it('passes the demo context so the nudge never chases the simulated appointment', async () => {
    vi.mocked(q.getConversationPersona).mockResolvedValue({
      activeRole: 'closer', roleStartedAt: '2026-07-30T17:55:00Z', demoStartedAt: null, promptVariant: null, reactivationRound: 0, leadTimezone: null, stage: null, interest: null,
    });
    vi.mocked(q.getLatestDemoSession).mockResolvedValue({
      leadData: { businessName: 'BeautyFull' }, endReason: 'booked', endedAt: null, booked: true,
    } as never);
    await runPendingFollowUps(agent);
    expect((await ctxArg()).demoContext).toEqual({ businessName: 'BeautyFull', booked: true });
  });

  it('a normal (non-demo) conversation is untouched: full history, no demo context', async () => {
    vi.mocked(q.getConversationPersona).mockResolvedValue({
      activeRole: null, roleStartedAt: null, demoStartedAt: null, promptVariant: null, reactivationRound: 0, leadTimezone: null, stage: null, interest: null,
    });
    await runPendingFollowUps(agent);
    expect(q.loadRecentMessages).toHaveBeenCalledWith('cv1', 20, undefined);
    expect((await ctxArg()).demoContext).toBeUndefined();
    expect(q.getLatestDemoSession).not.toHaveBeenCalled();
  });

  it('a failed demo-context read still sends the nudge', async () => {
    vi.mocked(q.getConversationPersona).mockResolvedValue({
      activeRole: 'closer', roleStartedAt: '2026-07-30T17:55:00Z', demoStartedAt: null, promptVariant: null, reactivationRound: 0, leadTimezone: null, stage: null, interest: null,
    });
    vi.mocked(q.getLatestDemoSession).mockRejectedValue(new Error('db down'));
    const res = await runPendingFollowUps(agent);
    expect(res.processed).toBe(1);
  });
});

describe('runPendingFollowUps — reactivation rounds (0049)', () => {
  const ctxArg = async () => {
    const { buildAgentRequestContext } = await import('../core/runtime-context.js');
    return vi.mocked(buildAgentRequestContext).mock.calls[0]?.[0] as {
      reactivationCandidates?: string[];
      reactivationRound?: { round: number; isFinalTouch: boolean; reentryKeyword: string };
    };
  };

  it('a round-1 row runs the platform taper ([360,1080]), not the tenant cadence', async () => {
    // Tenant cadence has 2 rungs too, so tier 2 is in range either way — the DELAY
    // of the next rung is what proves which shape was used (1080, not 1440).
    vi.mocked(q.loadDueFollowUps).mockResolvedValue([due({ round: 1, tier: 1 })]);
    await runPendingFollowUps(agent);
    expect(q.scheduleFollowUp).toHaveBeenCalledWith('cv1', 2, 1080, 'America/Mexico_City', null, 'cadence', 1, null);
    expect((await ctxArg()).reactivationRound).toEqual({ round: 1, isFinalTouch: false, reentryKeyword: 'CITA' });
  });

  it("the row's stamped round wins over the conversation's moved counter", async () => {
    vi.mocked(q.loadDueFollowUps).mockResolvedValue([due({ round: 0, tier: 1 })]);
    vi.mocked(q.getConversationPersona).mockResolvedValue({
      activeRole: null, roleStartedAt: null, demoStartedAt: null, promptVariant: null, reactivationRound: 1, leadTimezone: null, stage: null, interest: null,
    });
    await runPendingFollowUps(agent);
    // Round 0 = tenant cadence [60, 1440] → next rung at 1440, stamped round 0.
    expect(q.scheduleFollowUp).toHaveBeenCalledWith('cv1', 2, 1440, 'America/Mexico_City', null, 'cadence', 0, null);
  });

  it('tenant follow_up_rounds overrides the taper shape', async () => {
    vi.mocked(q.loadTenantConfig).mockResolvedValue(tenant({ followUpRounds: [[15, 30]] }));
    vi.mocked(q.loadDueFollowUps).mockResolvedValue([due({ round: 1, tier: 1 })]);
    await runPendingFollowUps(agent);
    expect(q.scheduleFollowUp).toHaveBeenCalledWith('cv1', 2, 30, 'America/Mexico_City', null, 'cadence', 1, null);
  });

  it('a round-1 row out of the taper range is skipped, not run against the tenant cadence', async () => {
    // Taper round 1 = [360, 1080] (2 rungs); tier 3 exists only in a longer cadence.
    vi.mocked(q.loadDueFollowUps).mockResolvedValue([due({ round: 1, tier: 3 })]);
    const res = await runPendingFollowUps(agent);
    expect(agent.generate).not.toHaveBeenCalled();
    expect(res.skipped).toBe(1);
  });

  it('a NON-final round exhausting → standby only, no event, no tag', async () => {
    // Round 0 of 3 total: last rung of the tenant cadence.
    vi.mocked(q.loadDueFollowUps).mockResolvedValue([due({ round: 0, tier: 2 })]);
    await runPendingFollowUps(agent);
    expect(q.updateConversationStatus).toHaveBeenCalledWith('conv1', 'standby');
    expect(q.logBotEvent).not.toHaveBeenCalledWith(
      expect.anything(), expect.anything(), 'reactivation_exhausted', expect.anything(),
    );
    expect(ghl.addContactTags).not.toHaveBeenCalled();
  });

  it('the FINAL round exhausting → standby + reactivation_exhausted + the GHL tag', async () => {
    // Default rounds: round 2 = [960], single rung — the farewell.
    vi.mocked(q.loadDueFollowUps).mockResolvedValue([due({ round: 2, tier: 1 })]);
    await runPendingFollowUps(agent);
    expect(q.updateConversationStatus).toHaveBeenCalledWith('conv1', 'standby');
    expect(q.logBotEvent).toHaveBeenCalledWith(
      'client1', 'conv1', 'reactivation_exhausted', expect.objectContaining({ round: 2 }),
    );
    expect(ghl.addContactTags).toHaveBeenCalledWith('c1', ['reactivacion-agotada']);
  });

  it('a failed exhausted-tag write is non-blocking', async () => {
    vi.mocked(q.loadDueFollowUps).mockResolvedValue([due({ round: 2, tier: 1 })]);
    ghl.addContactTags.mockRejectedValue(new Error('ghl 500'));
    const res = await runPendingFollowUps(agent);
    expect(res.processed).toBe(1);
  });

  it('the farewell bypasses the angle pool: no candidates offered, no angle consumed', async () => {
    vi.mocked(q.loadDueFollowUps).mockResolvedValue([due({ round: 2, tier: 1 })]);
    await runPendingFollowUps(agent);
    expect(q.loadSentAngleIndexes).not.toHaveBeenCalled();
    const ctx = await ctxArg();
    expect(ctx.reactivationCandidates).toEqual([]);
    expect(ctx.reactivationRound).toEqual({ round: 2, isFinalTouch: true, reentryKeyword: 'CITA' });
    // The remaining[0] fallback must not burn an angle on a message that isn't one.
    expect(q.markFollowUpSent).toHaveBeenCalledWith('fu1', null, null);
  });

  it('help mode: an upcoming appointment aborts the nudge before generating (store or GHL)', async () => {
    vi.mocked(findUpcomingAppointment).mockResolvedValue({ startTime: '2099-08-09T16:00:00Z' });
    const res = await runPendingFollowUps(agent);
    expect(agent.generate).not.toHaveBeenCalled();
    expect(ghl.sendMessage).not.toHaveBeenCalled();
    expect(q.scheduleFollowUp).not.toHaveBeenCalled();
    expect(q.logBotEvent).toHaveBeenCalledWith(
      'client1', 'conv1', 'followup_aborted', expect.objectContaining({ reason: 'has_upcoming_appointment' }),
    );
    expect(res.skipped).toBe(1);
  });

  it('the appointment check ALWAYS consults GHL — staff-booked appointments have no store row', async () => {
    await runPendingFollowUps(agent);
    expect(findUpcomingAppointment).toHaveBeenCalledWith(
      'client1', 'c1', expect.anything(), expect.any(Number), 'America/Mexico_City', { alwaysCheckGhl: true },
    );
  });

  it('a failed appointment check fails OPEN: the nudge still goes out', async () => {
    vi.mocked(findUpcomingAppointment).mockRejectedValue(new Error('db down'));
    const res = await runPendingFollowUps(agent);
    expect(ghl.sendMessage).toHaveBeenCalled();
    expect(res.processed).toBe(1);
  });

  it('demo-exit restart is round-aware: the closer resumes the lead round, not round 0', async () => {
    vi.mocked(q.loadDueFollowUps).mockResolvedValue([due({ kind: 'demo', tier: 3 })]);
    vi.mocked(q.countSentDemoReminders).mockResolvedValue(2);
    vi.mocked(q.getActiveDemoSession).mockResolvedValue({ id: 'sess1' } as never);
    vi.mocked(q.getConversationPersona).mockResolvedValue({
      activeRole: 'demo', roleStartedAt: null, demoStartedAt: null, promptVariant: null, reactivationRound: 1, leadTimezone: null, stage: null, interest: null,
    });
    await runPendingFollowUps(agent);
    expect(q.scheduleFollowUp).toHaveBeenCalledWith('cv1', 1, 360, 'America/Mexico_City', null, 'cadence', 1, null);
  });

  it('demo-exit restart arms NOTHING for a lead whose rounds are spent', async () => {
    vi.mocked(q.loadDueFollowUps).mockResolvedValue([due({ kind: 'demo', tier: 3 })]);
    vi.mocked(q.countSentDemoReminders).mockResolvedValue(2);
    vi.mocked(q.getActiveDemoSession).mockResolvedValue({ id: 'sess1' } as never);
    vi.mocked(q.getConversationPersona).mockResolvedValue({
      activeRole: 'demo', roleStartedAt: null, demoStartedAt: null, promptVariant: null, reactivationRound: 3, leadTimezone: null, stage: null, interest: null,
    });
    await runPendingFollowUps(agent);
    expect(q.setActiveRole).toHaveBeenCalledWith('conv1', 'closer'); // the rescue still happens
    expect(q.scheduleFollowUp).not.toHaveBeenCalled();               // but pursuit stays over
  });
});

describe('runPendingFollowUps — send-time gates and truthful delivery (0067)', () => {
  it('a human pause opened after the arming aborts the nudge instead of talking over them', async () => {
    vi.mocked(q.isBotSuppressed).mockResolvedValue(true);
    const res = await runPendingFollowUps(agent);
    expect(agent.generate).not.toHaveBeenCalled();
    expect(ghl.sendMessage).not.toHaveBeenCalled();
    expect(q.logBotEvent).toHaveBeenCalledWith('client1', 'conv1', 'followup_aborted', expect.objectContaining({ reason: 'human_active' }));
    expect(res.skipped).toBe(1);
  });

  it('a row claimed inside quiet hours is pushed to the window end, not sent and not lost', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-10-10T09:00:00Z')); // 03:00 in Mexico City — quiet
      const res = await runPendingFollowUps(agent);
      expect(ghl.sendMessage).not.toHaveBeenCalled();
      expect(q.cancelFollowUps).toHaveBeenCalledWith('cv1');
      expect(q.scheduleFollowUp).toHaveBeenCalledWith('cv1', 1, 0, 'America/Mexico_City', null, 'cadence', 0, null);
      expect(q.logBotEvent).toHaveBeenCalledWith('client1', 'conv1', 'followup_aborted', expect.objectContaining({ reason: 'quiet_hours', rescheduled: true }));
      expect(res.skipped).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('outside quiet hours the same row sends normally', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-10-10T18:00:00Z')); // 12:00 in Mexico City
      await runPendingFollowUps(agent);
      expect(ghl.sendMessage).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a send GHL refused is marked FAILED with a delivery_error, and the ladder still advances', async () => {
    ghl.sendMessage.mockRejectedValue(new Error('window closed'));
    await runPendingFollowUps(agent);
    expect(q.markFollowUpSent).not.toHaveBeenCalled();
    expect(q.markFollowUpFailed).toHaveBeenCalledWith('fu1');
    expect(q.logBotEvent).toHaveBeenCalledWith('client1', 'conv1', 'delivery_error', expect.objectContaining({ error: 'window closed', channel: 'whatsapp' }));
    expect(q.scheduleFollowUp).toHaveBeenCalledWith('cv1', 2, 1440, 'America/Mexico_City', null, 'cadence', 0, null);
  });
});

describe('runPendingFollowUps — the playbook: a ladder per stage (0068)', () => {
  const playbook = {
    stages: {
      NI: { cadence: [10, 60, 240], objective: 'informa, no pidas cita', angles: ['ni 1', 'ni 2'] },
      C: { cadence: [5, 30], angles: ['c 1'] },
    },
    byInterest: { Botox: { NI: { angles: ['botox ni 1'] } } },
  };
  const services = [{ name: 'Botox', description: 'Por zona: frente $2,500.' }];
  const ctxArg = async () => {
    const { buildAgentRequestContext } = await import('../core/runtime-context.js');
    return vi.mocked(buildAgentRequestContext).mock.calls[0]?.[0] as {
      reactivationCandidates?: string[];
      stageContext?: { stage: string; objective: string; service: { name: string; description: string | null } | null };
    };
  };

  it('no playbook → tenant cadence, tenant pool, no stage context (byte-identical to before)', async () => {
    vi.mocked(q.loadDueFollowUps).mockResolvedValue([due({ stage: 'NI' })]);
    await runPendingFollowUps(agent);
    const ctx = await ctxArg();
    expect(ctx.stageContext).toBeUndefined();
    expect(ctx.reactivationCandidates).toEqual(['angle A', 'angle B']);
    expect(q.loadSentAngleIndexes).toHaveBeenCalledWith('cv1', 'tenant');
    expect(q.scheduleFollowUp).toHaveBeenCalledWith('cv1', 2, 1440, 'America/Mexico_City', null, 'cadence', 0, 'NI');
  });

  it("the row's stage picks the cadence, the pool and the objective; the service facts ride along", async () => {
    vi.mocked(q.loadTenantConfig).mockResolvedValue(tenant({ followUpPlaybook: playbook, services }));
    vi.mocked(q.loadDueFollowUps).mockResolvedValue([due({ stage: 'NI' })]);
    vi.mocked(q.getConversationPersona).mockResolvedValue({
      activeRole: null, roleStartedAt: null, demoStartedAt: null, promptVariant: null, reactivationRound: 0, leadTimezone: null, stage: 'NI', interest: 'Botox',
    });
    await runPendingFollowUps(agent);
    const ctx = await ctxArg();
    expect(ctx.stageContext).toEqual({ stage: 'NI', objective: 'informa, no pidas cita', service: { name: 'Botox', description: 'Por zona: frente $2,500.' } });
    expect(ctx.reactivationCandidates).toEqual(['botox ni 1']);
    expect(q.loadSentAngleIndexes).toHaveBeenCalledWith('cv1', 'interest:Botox/NI');
    expect(q.markFollowUpSent).toHaveBeenCalledWith('fu1', 0, 'interest:Botox/NI');
    expect(q.scheduleFollowUp).toHaveBeenCalledWith('cv1', 2, 60, 'America/Mexico_City', null, 'cadence', 0, 'NI');
    expect(q.logBotEvent).toHaveBeenCalledWith('client1', 'conv1', 'follow_up_sent', expect.objectContaining({ stage: 'NI', pool: 'interest:Botox/NI', angleSource: 'interest', playbook: true }));
  });

  it('a pre-0068 row (no stage stamp) falls back to the conversation stage', async () => {
    vi.mocked(q.loadTenantConfig).mockResolvedValue(tenant({ followUpPlaybook: playbook }));
    vi.mocked(q.loadDueFollowUps).mockResolvedValue([due({ stage: null })]);
    vi.mocked(q.getConversationPersona).mockResolvedValue({
      activeRole: null, roleStartedAt: null, demoStartedAt: null, promptVariant: null, reactivationRound: 0, leadTimezone: null, stage: 'C', interest: null,
    });
    await runPendingFollowUps(agent);
    expect((await ctxArg()).reactivationCandidates).toEqual(['c 1']);
    expect((await ctxArg()).stageContext?.service).toBeNull();
    expect(q.scheduleFollowUp).toHaveBeenCalledWith('cv1', 2, 30, 'America/Mexico_City', null, 'cadence', 0, null);
  });

  it('a stage the playbook leaves out keeps the tenant ladder but still gets a platform objective', async () => {
    vi.mocked(q.loadTenantConfig).mockResolvedValue(tenant({ followUpPlaybook: playbook }));
    vi.mocked(q.loadDueFollowUps).mockResolvedValue([due({ stage: 'A' })]);
    await runPendingFollowUps(agent);
    const ctx = await ctxArg();
    expect(ctx.reactivationCandidates).toEqual(['angle A', 'angle B']);
    expect(ctx.stageContext?.stage).toBe('A');
    expect(ctx.stageContext?.objective).toContain('su caso');
    expect(q.scheduleFollowUp).toHaveBeenCalledWith('cv1', 2, 1440, 'America/Mexico_City', null, 'cadence', 0, 'A');
  });

  it('rounds 1+ keep the 0049 taper even with a playbook: the stage shapes round 0 only', async () => {
    vi.mocked(q.loadTenantConfig).mockResolvedValue(tenant({ followUpPlaybook: playbook }));
    vi.mocked(q.loadDueFollowUps).mockResolvedValue([due({ stage: 'NI', round: 1 })]);
    await runPendingFollowUps(agent);
    expect(q.scheduleFollowUp).toHaveBeenCalledWith('cv1', 2, 1080, 'America/Mexico_City', null, 'cadence', 1, 'NI');
  });

  it('the farewell carries no stage section and burns no angle, playbook or not', async () => {
    vi.mocked(q.loadTenantConfig).mockResolvedValue(tenant({ followUpPlaybook: playbook }));
    vi.mocked(q.loadDueFollowUps).mockResolvedValue([due({ stage: 'NI', round: 2 })]);
    await runPendingFollowUps(agent);
    expect((await ctxArg()).reactivationCandidates).toEqual([]);
    expect(q.markFollowUpSent).toHaveBeenCalledWith('fu1', null, null);
  });
});

describe('runPendingFollowUps — asset angles (0069)', () => {
  const pb = {
    stages: { NI: { cadence: [10, 60], angles: [{ asset: 'precios', text: 'manda la tabla' }, 'texto plano'] } },
  };
  const file = { slot: 'precios', kind: 'document' as const, url: 'https://x/precios.pdf', name: 'precios.pdf', interest: null };
  const ctx = () => vi.mocked(buildAgentRequestContext).mock.calls.at(-1)![0] as { reactivationCandidates: string[] };

  beforeEach(() => {
    vi.mocked(q.loadTenantConfig).mockResolvedValue(tenant({ followUpPlaybook: pb }));
    vi.mocked(q.loadDueFollowUps).mockResolvedValue([due({ stage: 'NI' })]);
    vi.mocked(parseAngleSelection).mockReturnValue({ message: 'aquí la tabla', angleChoice: 1 });
  });

  it('the tenant has the file → the chosen angle sends it with the text as caption, logs the attachment, stamps the event', async () => {
    vi.mocked(q.loadMediaAssets).mockResolvedValue([file]);
    await runPendingFollowUps(agent);
    // NI: the file is mandatory when available, so the asset angle is the only candidate.
    expect(ctx().reactivationCandidates).toHaveLength(1);
    expect(ctx().reactivationCandidates[0]).toContain('precios.pdf');
    expect(ghl.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      text: 'aquí la tabla', media: { kind: 'document', url: 'https://x/precios.pdf', name: 'precios.pdf' },
    }));
    expect(q.logMessage).toHaveBeenCalledWith(expect.objectContaining({ p_attachments: ['https://x/precios.pdf'] }));
    expect(q.logBotEvent).toHaveBeenCalledWith('client1', 'conv1', 'follow_up_sent', expect.objectContaining({ asset: 'precios', angleIndex: 0 }));
  });

  it('no file for the slot → the asset angle is NOT offered nor consumed; the text angle carries the touch', async () => {
    vi.mocked(q.loadMediaAssets).mockResolvedValue([]);
    await runPendingFollowUps(agent);
    expect(ctx().reactivationCandidates).toEqual(['texto plano']);
    expect(ghl.sendMessage).toHaveBeenCalledWith(expect.not.objectContaining({ media: expect.anything() }));
    expect(q.logMessage).toHaveBeenCalledWith(expect.objectContaining({ p_attachments: null }));
    // angleChoice 1 now points at 'texto plano' = pool index 1, so the asset angle stays unused.
    expect(q.markFollowUpSent).toHaveBeenCalledWith('fu1', 1, 'stage:NI');
  });

  it('a document on Instagram is not offered (the channel cannot carry it)', async () => {
    vi.mocked(q.loadMediaAssets).mockResolvedValue([file]);
    vi.mocked(q.loadDueFollowUps).mockResolvedValue([due({ stage: 'NI', channel: 'instagram' })]);
    await runPendingFollowUps(agent);
    expect(ctx().reactivationCandidates).toEqual(['texto plano']);
  });

  it('NI/I with a file available → ONLY the asset angles are offered (mandatory delivery)', async () => {
    vi.mocked(q.loadMediaAssets).mockResolvedValue([file]);
    await runPendingFollowUps(agent);
    expect(ctx().reactivationCandidates).toHaveLength(1);
    expect(ctx().reactivationCandidates[0]).toContain('precios.pdf');
  });

  it('A with a file available → free pick: text angles stay on the table', async () => {
    vi.mocked(q.loadTenantConfig).mockResolvedValue(tenant({
      followUpPlaybook: { stages: { A: { angles: [{ asset: 'precios', text: 'manda la tabla' }, 'texto plano'] } } },
    }));
    vi.mocked(q.loadDueFollowUps).mockResolvedValue([due({ stage: 'A' })]);
    vi.mocked(q.loadMediaAssets).mockResolvedValue([file]);
    await runPendingFollowUps(agent);
    expect(ctx().reactivationCandidates).toHaveLength(2);
  });

  it('a pool with no asset angles never reads media_assets', async () => {
    vi.mocked(q.loadTenantConfig).mockResolvedValue(tenant({ followUpPlaybook: { stages: { NI: { angles: ['a', 'b'] } } } }));
    await runPendingFollowUps(agent);
    expect(q.loadMediaAssets).not.toHaveBeenCalled();
  });
});
