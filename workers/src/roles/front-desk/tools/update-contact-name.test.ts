import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TenantContext, TurnContext } from '../../../core/types.js';

const ghl = { updateContactName: vi.fn() };
vi.mock('../../../ghl/client.js', () => ({ GhlClient: vi.fn(() => ghl) }));
vi.mock('../../../db/queries.js');

import * as q from '../../../db/queries.js';
import { updateContactNameTool } from './update-contact-name.js';

const tenant = {
  tenantId: 't1',
  clientId: 'client1',
  ghlLocationId: 'loc1',
  config: {
    businessName: 'Demo',
    timezone: 'America/Mexico_City',
    tone: null,
    services: [],
    hours: {},
    calendars: {},
    faq: [],
    promptOverrides: {},
  },
} as unknown as TenantContext;

const turn = { ghlContactId: 'c1', ghlConversationId: 'conv1', channel: 'whatsapp' } as TurnContext;

const ctx = {
  requestContext: { get: (k: string) => (k === 'tenant' ? tenant : k === 'turn' ? turn : undefined) },
};

// The tool's execute takes (input, toolCtx) in this Mastra version (see sibling tools).
const run = (name: string) =>
  (updateContactNameTool.execute as (i: { name: string }, c: typeof ctx) => Promise<{ ok: boolean }>)(
    { name },
    ctx,
  );

beforeEach(() => {
  vi.clearAllMocks();
  ghl.updateContactName.mockResolvedValue(undefined);
  vi.mocked(q.logBotEvent).mockResolvedValue(undefined);
});

describe('updateContactName tool', () => {
  it('single name → firstName set, lastName empty', async () => {
    const res = await run('Carlos');
    expect(ghl.updateContactName).toHaveBeenCalledWith('c1', { firstName: 'Carlos', lastName: '' });
    expect(res).toEqual({ ok: true });
  });

  it('full name → split into firstName/lastName', async () => {
    await run('Ana López Díaz');
    expect(ghl.updateContactName).toHaveBeenCalledWith('c1', { firstName: 'Ana', lastName: 'López Díaz' });
  });

  it('collapses extra whitespace before splitting', async () => {
    await run('  Ana   López  ');
    expect(ghl.updateContactName).toHaveBeenCalledWith('c1', { firstName: 'Ana', lastName: 'López' });
  });

  it('whitespace-only name → no-op, ok:false, no GHL call', async () => {
    const res = await run('   ');
    expect(ghl.updateContactName).not.toHaveBeenCalled();
    expect(res).toEqual({ ok: false });
  });

  it('GHL failure → ok:false and a bot event is logged (never throws)', async () => {
    ghl.updateContactName.mockRejectedValue(new Error('ghl 401'));
    const res = await run('Carlos');
    expect(res).toEqual({ ok: false });
    expect(q.logBotEvent).toHaveBeenCalledWith(
      'client1',
      'conv1',
      'db_error',
      expect.objectContaining({ stage: 'update_contact_name' }),
    );
  });
});

describe('updateContactName tool — demo guard', () => {
  it('no-ops in demo mode: the roleplay name never touches the real contact', async () => {
    const demoTurn = { ...turn, activeRole: 'demo' };
    const demoCtx = { requestContext: { get: (k: string) => (k === 'tenant' ? tenant : k === 'turn' ? demoTurn : undefined) } };
    const res = await (updateContactNameTool.execute as (i: { name: string }, c: typeof demoCtx) => Promise<{ ok: boolean }>)(
      { name: 'Cliente Ficticio' }, demoCtx,
    );
    expect(res).toEqual({ ok: true });
    expect(ghl.updateContactName).not.toHaveBeenCalled();
  });
});
