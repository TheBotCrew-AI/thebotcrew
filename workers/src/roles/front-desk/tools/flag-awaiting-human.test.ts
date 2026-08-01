import { describe, it, expect, vi, beforeEach } from 'vitest';

const ghl = { addContactTags: vi.fn() };
vi.mock('../../../ghl/client.js', () => ({ GhlClient: vi.fn(() => ghl) }));
vi.mock('../../../db/queries.js');

import * as q from '../../../db/queries.js';
import { flagAwaitingHumanTool } from './flag-awaiting-human.js';

const ctx = (awaitingHumanTag: string | null) => ({
  requestContext: {
    get: (k: string) =>
      k === 'tenant'
        ? {
            tenantId: 't1',
            clientId: 'client1',
            awaitingHumanTag,
            config: {
              businessName: 'MADI',
              timezone: 'America/Tijuana',
              tone: null,
              services: [],
              hours: {},
              calendars: {},
              faq: [],
              promptOverrides: { bookingEnabled: false },
            },
          }
        : k === 'turn'
        ? { ghlConversationId: 'conv1', ghlContactId: 'c1' }
        : undefined,
  },
});

const run = (c: unknown, args: Record<string, unknown> = {}) =>
  (flagAwaitingHumanTool as unknown as {
    execute: (a: Record<string, unknown>, c: unknown) => Promise<{ ok: boolean }>;
  }).execute(args, c);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(q.updateConversationStatus).mockResolvedValue(true);
  vi.mocked(q.logBotEvent).mockResolvedValue(undefined);
  ghl.addContactTags.mockResolvedValue(undefined);
});

describe('flagAwaitingHuman', () => {
  it('sets awaiting_human — not handed_off (mutes the bot) nor standby (a reply re-arms nudges)', async () => {
    await run(ctx('esperando-agenda'));
    expect(q.updateConversationStatus).toHaveBeenCalledWith('conv1', 'awaiting_human');
    expect(q.updateConversationStatus).not.toHaveBeenCalledWith('conv1', 'handed_off');
    expect(q.updateConversationStatus).not.toHaveBeenCalledWith('conv1', 'standby');
  });

  it("writes the tenant's own tag on the GHL contact", async () => {
    await run(ctx('esperando-agenda'));
    expect(ghl.addContactTags).toHaveBeenCalledWith('c1', ['esperando-agenda']);
  });

  it('skips the tag when the tenant has none configured', async () => {
    await run(ctx(null));
    expect(ghl.addContactTags).not.toHaveBeenCalled();
    // still records the request — the status change is the part that must not be lost
    expect(q.updateConversationStatus).toHaveBeenCalledWith('conv1', 'awaiting_human');
  });

  it('logs an awaiting_human event with the summary, for measuring response time', async () => {
    await run(ctx('esperando-agenda'), { summary: 'Axilas, prefiere por la tarde' });
    expect(q.logBotEvent).toHaveBeenCalledWith(
      'client1',
      'conv1',
      'awaiting_human',
      expect.objectContaining({ tag: 'esperando-agenda', summary: 'Axilas, prefiere por la tarde' }),
    );
  });

  it('a failing tag write never fails the turn', async () => {
    ghl.addContactTags.mockRejectedValue(new Error('GHL 500'));
    await expect(run(ctx('esperando-agenda'))).resolves.toEqual({ ok: true });
    expect(q.logBotEvent).toHaveBeenCalled();
  });
});

describe('flagAwaitingHuman — demo guard', () => {
  it('no-ops in demo mode: no status change, no tag on the real contact', async () => {
    const demoCtx = {
      requestContext: {
        get: (k: string) =>
          k === 'tenant'
            ? { tenantId: 't1', clientId: 'client1', awaitingHumanTag: 'esperando-agenda', config: { businessName: 'X', timezone: 'America/Tijuana', tone: null, services: [], hours: {}, calendars: {}, faq: [], promptOverrides: {} } }
            : k === 'turn'
            ? { ghlConversationId: 'conv1', ghlContactId: 'c1', activeRole: 'demo' }
            : undefined,
      },
    };
    const res = await run(demoCtx, { summary: 'quiere cita' });
    expect(res).toEqual({ ok: true });
    expect(q.updateConversationStatus).not.toHaveBeenCalled();
    expect(ghl.addContactTags).not.toHaveBeenCalled();
  });
});
