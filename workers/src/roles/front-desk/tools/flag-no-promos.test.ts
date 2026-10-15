import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TenantContext, TurnContext } from '../../../core/types.js';

const ghl = { addContactTags: vi.fn() };
vi.mock('../../../ghl/client.js', () => ({ GhlClient: vi.fn(() => ghl) }));
vi.mock('../../../db/queries.js');

import * as q from '../../../db/queries.js';
import { flagNoPromosTool } from './flag-no-promos.js';

const tenant = { tenantId: 't1', clientId: 'client1', config: { businessName: 'X', timezone: 'America/Mexico_City' } } as unknown as TenantContext;
const ctxFor = (turn: Partial<TurnContext>) => ({
  requestContext: { get: (k: string) => (k === 'tenant' ? tenant : k === 'turn' ? { ghlContactId: 'c1', ghlConversationId: 'conv1', ...turn } : undefined) },
});
const run = (turn: Partial<TurnContext> = {}) =>
  (flagNoPromosTool.execute as (i: Record<string, never>, c: ReturnType<typeof ctxFor>) => Promise<{ ok: boolean }>)({}, ctxFor(turn));

beforeEach(() => {
  vi.clearAllMocks();
  ghl.addContactTags.mockResolvedValue(undefined);
});

describe('flagNoPromos (0073)', () => {
  it('tags the contact no-promos and logs the event — the conversation status is untouched', async () => {
    const res = await run();
    expect(ghl.addContactTags).toHaveBeenCalledWith('c1', ['no-promos']);
    expect(q.logBotEvent).toHaveBeenCalledWith('client1', 'conv1', 'no_promos_on', { source: 'agent' });
    expect(q.updateConversationStatus).not.toHaveBeenCalled();
    expect(res).toEqual({ ok: true });
  });

  it('a failed tag write still returns ok — never fails the turn over the mirror', async () => {
    ghl.addContactTags.mockRejectedValue(new Error('ghl down'));
    await expect(run()).resolves.toEqual({ ok: true });
  });

  it('demo roleplay never tags the real contact', async () => {
    await run({ activeRole: 'demo' });
    expect(ghl.addContactTags).not.toHaveBeenCalled();
    expect(q.logBotEvent).not.toHaveBeenCalled();
  });
});
