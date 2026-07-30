import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TenantContext, TurnContext } from '../../../core/types.js';

const ghl = { addContactTags: vi.fn() };
vi.mock('../../../ghl/client.js', () => ({ GhlClient: vi.fn(() => ghl) }));
vi.mock('../../../db/queries.js');

import * as q from '../../../db/queries.js';
import { updateConversationStatusTool } from './update-conversation-status.js';

const tenant = { tenantId: 't1', clientId: 'client1', ghlLocationId: 'loc1', config: { businessName: 'X', timezone: 'America/Mexico_City' } } as unknown as TenantContext;
const turn = { ghlContactId: 'c1', ghlConversationId: 'conv1' } as TurnContext;
const ctx = { requestContext: { get: (k: string) => (k === 'tenant' ? tenant : k === 'turn' ? turn : undefined) } };
const run = (status: string) =>
  (updateConversationStatusTool.execute as (i: { status: string }, c: typeof ctx) => Promise<{ ok: boolean }>)({ status }, ctx);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(q.updateConversationStatus).mockResolvedValue(undefined);
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

  it('a tag sync failure never fails the tool', async () => {
    ghl.addContactTags.mockRejectedValue(new Error('ghl 500'));
    const res = await run('standby');
    expect(q.updateConversationStatus).toHaveBeenCalledWith('conv1', 'standby');
    expect(res).toEqual({ ok: true });
  });
});

describe('updateConversationStatus tool — demo guard', () => {
  it('no-ops in demo mode: real status and real tags stay untouched', async () => {
    const demoTurn = { ...turn, activeRole: 'demo' };
    const demoCtx = { requestContext: { get: (k: string) => (k === 'tenant' ? tenant : k === 'turn' ? demoTurn : undefined) } };
    const res = await (updateConversationStatusTool.execute as (i: { status: string }, c: typeof demoCtx) => Promise<{ ok: boolean }>)(
      { status: 'opted_out' }, demoCtx,
    );
    expect(res).toEqual({ ok: true }); // pretend success so the model closes gracefully
    expect(q.updateConversationStatus).not.toHaveBeenCalled();
    expect(ghl.addContactTags).not.toHaveBeenCalled();
  });
});
