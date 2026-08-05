import { describe, it, expect, vi, beforeEach } from 'vitest';

const ghl = { addContactTags: vi.fn() };
vi.mock('../../../ghl/client.js', () => ({ GhlClient: vi.fn(() => ghl) }));
vi.mock('../../../db/queries.js');

import * as q from '../../../db/queries.js';
import { flagPendingInfoTool } from './flag-pending-info.js';

const ctx = (pendingInfoTag: string | null, activeRole?: string) => ({
  requestContext: {
    get: (k: string) =>
      k === 'tenant'
        ? {
            tenantId: 't1',
            clientId: 'client1',
            awaitingHumanTag: 'esperando-agenda',
            pendingInfoTag,
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
        ? { ghlConversationId: 'conv1', ghlContactId: 'c1', ...(activeRole ? { activeRole } : {}) }
        : undefined,
  },
});

const run = (c: unknown, args: Record<string, unknown> = { question: '¿aceptan tarjeta?' }) =>
  (flagPendingInfoTool as unknown as {
    execute: (a: Record<string, unknown>, c: unknown) => Promise<{ ok: boolean }>;
  }).execute(args, c);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(q.updateConversationStatus).mockResolvedValue(true);
  vi.mocked(q.logBotEvent).mockResolvedValue(undefined);
  ghl.addContactTags.mockResolvedValue(undefined);
});

describe('flagPendingInfo', () => {
  it('parks the lead in awaiting_human — nudging someone we owe an answer is backwards', async () => {
    await run(ctx('dato-pendiente'));
    expect(q.updateConversationStatus).toHaveBeenCalledWith('conv1', 'awaiting_human');
    // handed_off would MUTE the bot: she must still get answers to everything else.
    expect(q.updateConversationStatus).not.toHaveBeenCalledWith('conv1', 'handed_off');
  });

  it("writes the tenant's pending-info tag, NOT the booking one — they are separate queues", async () => {
    await run(ctx('dato-pendiente'));
    expect(ghl.addContactTags).toHaveBeenCalledWith('c1', ['dato-pendiente']);
    expect(ghl.addContactTags).not.toHaveBeenCalledWith('c1', ['esperando-agenda']);
  });

  it('skips the tag when the tenant configured none, but still parks and logs', async () => {
    await run(ctx(null));
    expect(ghl.addContactTags).not.toHaveBeenCalled();
    expect(q.updateConversationStatus).toHaveBeenCalledWith('conv1', 'awaiting_human');
    expect(q.logBotEvent).toHaveBeenCalled();
  });

  it("logs the lead's question verbatim — the tag dies on handling, the event is the backlog", async () => {
    await run(ctx('dato-pendiente'), { question: '¿Puedo pagar en mensualidades?', topic: 'formas de pago' });
    expect(q.logBotEvent).toHaveBeenCalledWith(
      'client1',
      'conv1',
      'pending_info',
      expect.objectContaining({
        tag: 'dato-pendiente',
        question: '¿Puedo pagar en mensualidades?',
        topic: 'formas de pago',
      }),
    );
  });

  it('truncates a runaway question instead of writing an unbounded payload', async () => {
    await run(ctx('dato-pendiente'), { question: 'x'.repeat(900) });
    const meta = vi.mocked(q.logBotEvent).mock.calls[0]![3] as { question: string };
    expect(meta.question).toHaveLength(500);
  });

  it('a failing tag write never fails the turn', async () => {
    ghl.addContactTags.mockRejectedValue(new Error('GHL 500'));
    await expect(run(ctx('dato-pendiente'))).resolves.toEqual({ ok: true });
    expect(q.logBotEvent).toHaveBeenCalled();
  });
});

describe('flagPendingInfo — demo guard', () => {
  it('no-ops in demo mode: the roleplay business has NO config, so everything is a gap', async () => {
    const res = await run(ctx('dato-pendiente', 'demo'), { question: '¿cuánto cuesta un corte?' });
    expect(res).toEqual({ ok: true });
    expect(q.updateConversationStatus).not.toHaveBeenCalled();
    expect(ghl.addContactTags).not.toHaveBeenCalled();
    expect(q.logBotEvent).not.toHaveBeenCalled();
  });
});
