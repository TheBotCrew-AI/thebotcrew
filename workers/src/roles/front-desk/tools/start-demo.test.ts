import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TenantContext, TurnContext } from '../../../core/types.js';

const ghl = { addContactTags: vi.fn() };
vi.mock('../../../ghl/client.js', () => ({ GhlClient: vi.fn(() => ghl) }));
vi.mock('../../../db/queries.js');

import * as q from '../../../db/queries.js';
import { DEMO_EXPIRES_MINUTES, DEMO_MESSAGE_BUDGET, startDemoTool } from './start-demo.js';

const tenant = (demoSessionsEnabled: boolean) =>
  ({
    tenantId: 't1',
    clientId: 'client1',
    demoSessionsEnabled,
    config: { businessName: 'The Bot Crew', timezone: 'America/Tijuana', tone: null, services: [], hours: {}, calendars: {}, faq: [], promptOverrides: {} },
  } as unknown as TenantContext);

const ctx = (t: TenantContext, turn: Partial<TurnContext> = {}) => ({
  requestContext: {
    get: (k: string) =>
      k === 'tenant' ? t : k === 'turn' ? ({ ghlConversationId: 'conv1', ghlContactId: 'c1', channel: 'whatsapp', ...turn } as TurnContext) : undefined,
  },
});

const input = {
  businessName: 'Clínica Sonrisa',
  businessType: 'clínica dental',
  services: ['Limpieza', 'Blanqueamiento'],
};

const run = (c: unknown, i: Record<string, unknown> = input) =>
  (startDemoTool as unknown as {
    execute: (a: Record<string, unknown>, c: unknown) => Promise<{ ok: boolean; message: string }>;
  }).execute(i, c);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(q.createDemoSession).mockResolvedValue('sess-1');
  vi.mocked(q.logBotEvent).mockResolvedValue(undefined);
  ghl.addContactTags.mockResolvedValue(undefined);
});

describe('startDemo tool', () => {
  it('refuses when the tenant has demo sessions disabled (the per-tenant gate)', async () => {
    const res = await run(ctx(tenant(false)));
    expect(res.ok).toBe(false);
    expect(q.createDemoSession).not.toHaveBeenCalled();
  });

  it('refuses from inside an active demo (the roleplay cannot spawn demos)', async () => {
    const res = await run(ctx(tenant(true), { activeRole: 'demo' }));
    expect(res.ok).toBe(false);
    expect(q.createDemoSession).not.toHaveBeenCalled();
  });

  it('creates the session with the platform budget/expiry and logs the event', async () => {
    const res = await run(ctx(tenant(true)));
    expect(res.ok).toBe(true);
    expect(q.createDemoSession).toHaveBeenCalledWith(
      expect.objectContaining({
        ghlConversationId: 'conv1',
        messageBudget: DEMO_MESSAGE_BUDGET,
        expiresMinutes: DEMO_EXPIRES_MINUTES,
        leadData: expect.objectContaining({ businessName: 'Clínica Sonrisa' }),
        promptOverrides: expect.objectContaining({ bookingEnabled: true }),
      }),
    );
    expect(q.logBotEvent).toHaveBeenCalledWith(
      'client1', 'conv1', 'demo_session_started',
      expect.objectContaining({ sessionId: 'sess-1' }),
    );
  });

  it('a DB failure returns ok:false with guidance, never throws into the turn', async () => {
    vi.mocked(q.createDemoSession).mockRejectedValue(new Error('db down'));
    const res = await run(ctx(tenant(true)));
    expect(res.ok).toBe(false);
    expect(q.logBotEvent).toHaveBeenCalledWith(
      'client1', 'conv1', 'db_error',
      expect.objectContaining({ stage: 'create_demo_session' }),
    );
  });
});

describe('startDemo tool — funnel tag', () => {
  it('tags the contact demo-iniciada on session creation (best-effort)', async () => {
    await run(ctx(tenant(true)));
    expect(ghl.addContactTags).toHaveBeenCalledWith('c1', ['demo-iniciada']);
  });

  it('a tag failure never fails the demo activation', async () => {
    ghl.addContactTags.mockRejectedValue(new Error('ghl 500'));
    const res = await run(ctx(tenant(true)));
    expect(res.ok).toBe(true);
  });
});
