import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TenantContext, TurnContext } from '../../../core/types.js';

const ghl = { updateContactTimezone: vi.fn() };
vi.mock('../../../ghl/client.js', () => ({ GhlClient: vi.fn(() => ghl) }));
vi.mock('../../../db/queries.js');

import * as q from '../../../db/queries.js';
import { setLeadTimezoneTool } from './set-lead-timezone.js';

function makeCtx(opts: { enabled?: boolean; activeRole?: string; leadTimezone?: string } = {}) {
  const tenant = {
    tenantId: 't1',
    clientId: 'client1',
    ghlLocationId: 'loc1',
    config: {
      businessName: 'Demo',
      timezone: 'America/Tijuana',
      tone: null,
      services: [],
      hours: {},
      calendars: {},
      faq: [],
      promptOverrides: {},
      leadTimezoneEnabled: opts.enabled ?? true,
    },
  } as unknown as TenantContext;
  const turn = {
    ghlContactId: 'c1',
    ghlConversationId: 'conv1',
    channel: 'whatsapp',
    activeRole: opts.activeRole,
    leadTimezone: opts.leadTimezone,
  } as TurnContext;
  return { turn, ctx: { requestContext: { get: (k: string) => (k === 'tenant' ? tenant : k === 'turn' ? turn : undefined) } } };
}

type Out = { ok: boolean; timezone?: string; message: string };
const run = (place: string, ctx: ReturnType<typeof makeCtx>['ctx']) =>
  (setLeadTimezoneTool.execute as (i: { place: string }, c: typeof ctx) => Promise<Out>)({ place }, ctx);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(q.setLeadTimezone).mockResolvedValue(true);
  ghl.updateContactTimezone.mockResolvedValue(undefined);
});

describe('setLeadTimezone tool', () => {
  it('resolves the place in code, persists it as the lead\'s word, and updates the live turn', async () => {
    const { turn, ctx } = makeCtx({ leadTimezone: 'America/Mexico_City' });
    const res = await run('estoy en Cancún', ctx);
    expect(res.ok).toBe(true);
    expect(res.timezone).toBe('America/Cancun');
    expect(res.message).toContain('hora de Cancún');
    expect(q.setLeadTimezone).toHaveBeenCalledWith('conv1', 'America/Cancun', 'lead');
    // The same object getAvailability reads later in this turn.
    expect(turn.leadTimezone).toBe('America/Cancun');
    // And the GHL contact, so GHL's own confirmation workflow renders in the lead's clock.
    expect(ghl.updateContactTimezone).toHaveBeenCalledWith('c1', 'America/Cancun');
  });

  it('a GHL contact update that fails does not fail the tool', async () => {
    ghl.updateContactTimezone.mockRejectedValue(new Error('401'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { turn, ctx } = makeCtx();
    const res = await run('Cancún', ctx);
    expect(res.ok).toBe(true);
    expect(turn.leadTimezone).toBe('America/Cancun');
    spy.mockRestore();
  });

  it('an unrecognised place with a zone already on file keeps that zone and does not stall', async () => {
    const { turn, ctx } = makeCtx({ leadTimezone: 'America/Mexico_City' });
    const res = await run('Polanco', ctx);
    expect(res.ok).toBe(false);
    expect(res.timezone).toBe('America/Mexico_City');
    expect(res.message).toContain('se conserva');
    expect(res.message).toContain('hora de Ciudad de México');
    expect(q.setLeadTimezone).not.toHaveBeenCalled();
    expect(turn.leadTimezone).toBe('America/Mexico_City');
  });

  it('refuses a place it does not recognise — and says so, instead of guessing', async () => {
    const { turn, ctx } = makeCtx();
    const res = await run('por acá', ctx);
    expect(res.ok).toBe(false);
    expect(res.timezone).toBeUndefined();
    expect(res.message).toContain('No reconocí');
    expect(q.setLeadTimezone).not.toHaveBeenCalled();
    expect(ghl.updateContactTimezone).not.toHaveBeenCalled();
    expect(turn.leadTimezone).toBeUndefined();
  });

  it('is a no-op for a tenant that did not opt in (walk-in business)', async () => {
    const { turn, ctx } = makeCtx({ enabled: false });
    const res = await run('Monterrey', ctx);
    expect(res.ok).toBe(true);
    expect(res.timezone).toBeUndefined();
    expect(q.setLeadTimezone).not.toHaveBeenCalled();
    expect(turn.leadTimezone).toBeUndefined();
  });

  it('is a no-op inside the demo roleplay', async () => {
    const { ctx } = makeCtx({ activeRole: 'demo' });
    await run('Monterrey', ctx);
    expect(q.setLeadTimezone).not.toHaveBeenCalled();
  });

  it('keeps the zone for the turn even when persistence fails', async () => {
    vi.mocked(q.setLeadTimezone).mockRejectedValue(new Error('db down'));
    const { turn, ctx } = makeCtx();
    const res = await run('Hermosillo', ctx);
    expect(res.ok).toBe(true);
    expect(turn.leadTimezone).toBe('America/Hermosillo');
  });
});
