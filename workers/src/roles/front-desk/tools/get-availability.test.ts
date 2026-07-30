import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TenantContext, TurnContext } from '../../../core/types.js';

const ghl = { getAvailability: vi.fn() };
vi.mock('../../../ghl/client.js', () => ({ GhlClient: vi.fn(() => ghl) }));
vi.mock('../../../db/queries.js');

import * as q from '../../../db/queries.js';
import { getAvailabilityTool } from './get-availability.js';

function makeCtx(bookingHorizonDays: number | null = null) {
  const tenant = {
    tenantId: 't1',
    clientId: 'client1',
    ghlLocationId: 'loc1',
    config: {
      businessName: 'Demo',
      timezone: 'America/Mexico_City',
      tone: null,
      services: [{ name: 'Consulta', durationMin: 30 }],
      hours: {},
      calendars: { Consulta: 'cal1' },
      faq: [],
      promptOverrides: {},
      bookingHorizonDays,
    },
  } as unknown as TenantContext;
  const turn = { ghlContactId: 'c1', ghlConversationId: 'conv1', channel: 'whatsapp' } as TurnContext;
  return { requestContext: { get: (k: string) => (k === 'tenant' ? tenant : k === 'turn' ? turn : undefined) } };
}

type Out = { slots: { start: string; end: string; label: string }[]; note?: string };
const run = (input: { serviceName: string; fromDate?: string; toDate?: string }, ctx = makeCtx()) =>
  (getAvailabilityTool.execute as (i: typeof input, c: ReturnType<typeof makeCtx>) => Promise<Out>)(input, ctx);

const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(q.logBotEvent).mockResolvedValue(undefined);
  ghl.getAvailability.mockResolvedValue([]);
});

describe('getAvailability', () => {
  it('unknown service → empty + note, GHL never called, event logged', async () => {
    const res = await run({ serviceName: 'NoExiste' });
    expect(res.slots).toEqual([]);
    expect(res.note).toContain('No hay un calendario configurado');
    expect(ghl.getAvailability).not.toHaveBeenCalled();
    expect(q.logBotEvent).toHaveBeenCalledWith('client1', 'conv1', 'availability_checked', expect.objectContaining({ outcome: 'no_calendar_configured' }));
  });

  it('returns labeled slots + guidance note', async () => {
    ghl.getAvailability.mockResolvedValue([{ start: inDays(1), end: inDays(1) }]);
    const res = await run({ serviceName: 'Consulta' });
    expect(res.slots).toHaveLength(1);
    expect(res.slots[0]).toHaveProperty('label');
    expect(typeof res.slots[0]!.label).toBe('string');
    expect(res.note).toContain('EXACTAMENTE el texto del campo "label"');
  });

  it('no slots in range → "sin disponibilidad" note', async () => {
    ghl.getAvailability.mockResolvedValue([]);
    const res = await run({ serviceName: 'Consulta' });
    expect(res.slots).toEqual([]);
    expect(res.note).toContain('Sin disponibilidad');
  });

  it('requested range entirely beyond the horizon → out-of-horizon note, GHL not called', async () => {
    const res = await run({ serviceName: 'Consulta', fromDate: inDays(30) }, makeCtx(7));
    expect(res.slots).toEqual([]);
    expect(res.note).toContain('Solo se pueden agendar');
    expect(ghl.getAvailability).not.toHaveBeenCalled();
    expect(q.logBotEvent).toHaveBeenCalledWith('client1', 'conv1', 'availability_checked', expect.objectContaining({ outcome: 'out_of_horizon' }));
  });

  it('range overshoots the horizon → clamped, note flags the limit', async () => {
    ghl.getAvailability.mockResolvedValue([{ start: inDays(2), end: inDays(2) }]);
    const res = await run({ serviceName: 'Consulta', fromDate: inDays(0), toDate: inDays(30) }, makeCtx(7));
    expect(res.note).toContain('IMPORTANTE');
    // the 'to' passed to GHL is clamped to ~now+7d, never the requested +30d
    const toArg = new Date(ghl.getAvailability.mock.calls[0]![2] as string).getTime();
    expect(toArg).toBeLessThan(Date.now() + 8 * 86_400_000);
  });

  it('GHL error → empty + error note + event', async () => {
    ghl.getAvailability.mockRejectedValue(new Error('ghl 500'));
    const res = await run({ serviceName: 'Consulta' });
    expect(res.slots).toEqual([]);
    expect(res.note).toContain('No se pudo consultar disponibilidad');
    expect(q.logBotEvent).toHaveBeenCalledWith('client1', 'conv1', 'availability_checked', expect.objectContaining({ outcome: 'error' }));
  });
});

describe('getAvailability — demo mode (simulated slots)', () => {
  const demoCtx = () => {
    const base = makeCtx();
    const tenant = base.requestContext.get('tenant');
    const turn = { ghlContactId: 'c1', ghlConversationId: 'conv1', channel: 'whatsapp', activeRole: 'demo' } as TurnContext;
    return { requestContext: { get: (k: string) => (k === 'tenant' ? tenant : k === 'turn' ? turn : undefined) } };
  };

  it('returns simulated slots without ever calling GHL — even for an unconfigured service', async () => {
    vi.mocked(q.getActiveDemoSession).mockResolvedValue(null);
    const res = await run({ serviceName: 'Limpieza dental del negocio del lead' }, demoCtx() as ReturnType<typeof makeCtx>);
    expect(res.slots.length).toBeGreaterThan(0);
    expect(res.slots[0]?.label).toBeTruthy();
    expect(ghl.getAvailability).not.toHaveBeenCalled();
    expect(q.logBotEvent).toHaveBeenCalledWith('client1', 'conv1', 'availability_checked', expect.objectContaining({ demo: true }));
  });

  it('excludes the session simulated booking from the offered slots', async () => {
    vi.mocked(q.getActiveDemoSession).mockResolvedValue(null);
    const first = await run({ serviceName: 'X' }, demoCtx() as ReturnType<typeof makeCtx>);
    const booked = first.slots[0]!.start;
    vi.mocked(q.getActiveDemoSession).mockResolvedValue({
      id: 's1', activatedAt: '', expiresAt: '', messageBudget: 15, personaVersion: 1,
      leadData: {}, promptOverrides: {}, simulatedBooking: { startTime: booked, serviceName: 'X', label: 'x' },
    });
    const res = await run({ serviceName: 'X' }, demoCtx() as ReturnType<typeof makeCtx>);
    expect(res.slots.map((s) => s.start)).not.toContain(booked);
  });
});
