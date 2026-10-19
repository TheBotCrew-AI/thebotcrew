import { describe, it, expect, vi, beforeEach } from 'vitest';

const ghl = { addContactTags: vi.fn(), createContactTask: vi.fn() };
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
              bookingHorizonDays: 7,
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
  ghl.createContactTask.mockResolvedValue('task1');
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

  describe('waitlist (a date outside the horizon)', () => {
    it('creates a GHL task due the day the date enters the window, and logs it on the event', async () => {
      vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-19T18:00:00Z'));
      await run(ctx('esperando-agenda'), { summary: 'lista de espera: 3 de noviembre — láser', waitlistDate: '2026-11-03' });
      expect(ghl.createContactTask).toHaveBeenCalledWith('c1', expect.objectContaining({ title: expect.stringContaining('3 de noviembre'), dueDate: '2026-10-27T16:00:00.000Z' })); // 09:00 PDT
      expect(q.updateConversationStatus).toHaveBeenCalledWith('conv1', 'awaiting_human');
      expect(ghl.addContactTags).toHaveBeenCalledWith('c1', ['esperando-agenda']);
      expect(q.logBotEvent).toHaveBeenCalledWith('client1', 'conv1', 'awaiting_human', expect.objectContaining({ waitlist: { date: '2026-11-03', dueDay: '2026-10-27', taskId: 'task1' } }));
      vi.mocked(Date.now).mockRestore();
    });

    it('a failed task write never fails the turn — the lead is still noted', async () => {
      ghl.createContactTask.mockRejectedValue(new Error('401'));
      const out = await run(ctx('esperando-agenda'), { waitlistDate: '2026-11-03' });
      expect(out.ok).toBe(true);
      expect(q.logBotEvent).toHaveBeenCalledWith('client1', 'conv1', 'awaiting_human', expect.objectContaining({ waitlist: expect.objectContaining({ taskId: null }) }));
    });

    it('a non-date waitlistDate creates no task', async () => {
      await run(ctx('esperando-agenda'), { waitlistDate: 'la semana que entra' });
      expect(ghl.createContactTask).not.toHaveBeenCalled();
    });

    it('no waitlistDate → no task (the plain awaiting-human flow is untouched)', async () => {
      await run(ctx('esperando-agenda'), { summary: 'valoración, por la tarde' });
      expect(ghl.createContactTask).not.toHaveBeenCalled();
    });
  });
});
