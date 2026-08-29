import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TenantContext, TurnContext } from '../../../core/types.js';

const ghl = { addContactTags: vi.fn() };
vi.mock('../../../ghl/client.js', () => ({ GhlClient: vi.fn(() => ghl) }));
vi.mock('../../../db/queries.js');
vi.mock('../../../meta/capi.js');

import * as q from '../../../db/queries.js';
import { queueCapiStatusEvent } from '../../../meta/capi.js';
import { updateConversationStatusTool } from './update-conversation-status.js';

const tenant = { tenantId: 't1', clientId: 'client1', ghlLocationId: 'loc1', config: { businessName: 'X', timezone: 'America/Mexico_City' } } as unknown as TenantContext;
const turn = { ghlContactId: 'c1', ghlConversationId: 'conv1' } as TurnContext;
const ctx = { requestContext: { get: (k: string) => (k === 'tenant' ? tenant : k === 'turn' ? turn : undefined) } };
const run = (status: string, reason?: string) =>
  (updateConversationStatusTool.execute as (i: { status: string; reason?: string }, c: typeof ctx) => Promise<{ ok: boolean }>)(
    { status, reason },
    ctx,
  );

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(q.updateConversationStatus).mockResolvedValue(true);
  ghl.addContactTags.mockResolvedValue(undefined);
});

describe('updateConversationStatus tool', () => {
  it('updates status and mirrors the matching tag onto the contact', async () => {
    const res = await run('completed');
    expect(q.updateConversationStatus).toHaveBeenCalledWith('conv1', 'completed');
    expect(ghl.addContactTags).toHaveBeenCalledWith('c1', ['bot-completed']);
    expect(res).toEqual({ ok: true });
  });

  it('handed_off writes the bot-off kill-switch tag', async () => {
    await run('handed_off');
    expect(ghl.addContactTags).toHaveBeenCalledWith('c1', ['bot-off']);
  });

  it('a stated reason is logged as lead_disqualified alongside the status change', async () => {
    await run('standby', 'no agenda citas');
    expect(q.logBotEvent).toHaveBeenCalledWith('client1', 'conv1', 'lead_disqualified', {
      status: 'standby',
      reason: 'no agenda citas',
    });
  });

  it('no reason means no event — an ordinary standby stays indistinguishable from before', async () => {
    await run('standby');
    expect(q.updateConversationStatus).toHaveBeenCalledWith('conv1', 'standby');
    expect(q.logBotEvent).not.toHaveBeenCalled();
  });

  it('a reason on `completed` is dropped — a booked lead is not a disqualification', async () => {
    await run('completed', 'Cita agendada');
    expect(q.updateConversationStatus).toHaveBeenCalledWith('conv1', 'completed');
    expect(q.logBotEvent).not.toHaveBeenCalledWith('client1', 'conv1', 'lead_disqualified', expect.anything());
  });

  it('the reason rides along on any status, not just standby', async () => {
    await run('handed_off', 'pidió hablar con una persona');
    expect(q.logBotEvent).toHaveBeenCalledWith('client1', 'conv1', 'lead_disqualified', {
      status: 'handed_off',
      reason: 'pidió hablar con una persona',
    });
  });

  it('a tag sync failure never fails the tool', async () => {
    ghl.addContactTags.mockRejectedValue(new Error('ghl 500'));
    const res = await run('standby');
    expect(q.updateConversationStatus).toHaveBeenCalledWith('conv1', 'standby');
    expect(res).toEqual({ ok: true });
  });

  it('an applied status change reaches the Meta CAPI hook (0048; helper filters to `completed`)', async () => {
    await run('completed');
    expect(queueCapiStatusEvent).toHaveBeenCalledWith(tenant, 'conv1', 'completed');
  });
});

describe('updateConversationStatus tool — refused write (awaiting_human, 0044)', () => {
  // The RPC is the guard; these cover the half the DB can't: what the Worker does
  // with a `false`. Writing the tag anyway is the visible failure — GHL would show
  // `bot-standby` on a contact still tagged `esperando-agenda`.
  beforeEach(() => vi.mocked(q.updateConversationStatus).mockResolvedValue(false));

  it('does not mirror a status tag when the RPC refused the change', async () => {
    const res = await run('standby');
    expect(q.updateConversationStatus).toHaveBeenCalledWith('conv1', 'standby');
    expect(ghl.addContactTags).not.toHaveBeenCalled();
    expect(res).toEqual({ ok: true }); // the model closes its turn; retrying can't win
  });

  it('does not log lead_disqualified for a lead who was never actually parked', async () => {
    await run('standby', 'no agenda citas');
    expect(q.logBotEvent).not.toHaveBeenCalled();
  });

  it('a refused change signals nothing to Meta either (0048)', async () => {
    await run('completed');
    expect(queueCapiStatusEvent).not.toHaveBeenCalled();
  });
});

describe('updateConversationStatus tool — demo guard', () => {
  it('no-ops in demo mode: real status and real tags stay untouched', async () => {
    const demoTurn = { ...turn, activeRole: 'demo' };
    const demoCtx = { requestContext: { get: (k: string) => (k === 'tenant' ? tenant : k === 'turn' ? demoTurn : undefined) } };
    const res = await (
      updateConversationStatusTool.execute as (i: { status: string; reason?: string }, c: typeof demoCtx) => Promise<{ ok: boolean }>
    )({ status: 'opted_out', reason: 'el cliente del roleplay se molestó' }, demoCtx);
    expect(res).toEqual({ ok: true }); // pretend success so the model closes gracefully
    expect(q.updateConversationStatus).not.toHaveBeenCalled();
    expect(ghl.addContactTags).not.toHaveBeenCalled();
    // A roleplayed reason must not pollute the real funnel's disqualification stats.
    expect(q.logBotEvent).not.toHaveBeenCalled();
    // Nor does roleplay signal a conversion to Meta (0048).
    expect(queueCapiStatusEvent).not.toHaveBeenCalled();
  });
});
