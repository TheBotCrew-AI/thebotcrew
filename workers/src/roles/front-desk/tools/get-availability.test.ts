import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { TenantContext, TurnContext } from '../../../core/types.js';

const ghl = { getAvailability: vi.fn() };
vi.mock('../../../ghl/client.js', () => ({ GhlClient: vi.fn(() => ghl) }));
vi.mock('../../../db/queries.js');

import * as q from '../../../db/queries.js';
import { getAvailabilityTool } from './get-availability.js';

function makeCtx(bookingHorizonDays: number | null = null, lead: { enabled?: boolean; leadTimezone?: string; activeRole?: string } = {}) {
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
      leadTimezoneEnabled: lead.enabled ?? false,
    },
  } as unknown as TenantContext;
  const turn = { ghlContactId: 'c1', ghlConversationId: 'conv1', channel: 'whatsapp', leadTimezone: lead.leadTimezone, activeRole: lead.activeRole } as TurnContext;
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

  // 0057: a remote-service tenant renders slots in the LEAD's clock, labelled. The
  // instant is 18:00Z → 12:00 p.m. in Mexico City (-06:00), 11:00 a.m. in Tijuana (-07:00
  // in summer) and 1:00 p.m. in Cancún (-05:00). Only the label changes; `start` stays the
  // exact GHL string bookAppointment needs.
  describe('lead timezone (0057)', () => {
    const START = '2026-09-03T18:00:00.000Z';
    beforeEach(() => ghl.getAvailability.mockResolvedValue([{ start: START, end: START }]));

    it('labels in the lead zone with a "hora de …" suffix when it differs from the calendar', async () => {
      const res = await run({ serviceName: 'Consulta' }, makeCtx(null, { enabled: true, leadTimezone: 'America/Cancun' }));
      expect(res.slots[0]!.label).toMatch(/1:00 p\.?\s?m\./);
      expect(res.slots[0]!.label).toContain('hora de Cancún');
      expect(res.slots[0]!.start).toBe(START);
    });

    it('drops the suffix when the lead reads the same clock as the calendar', async () => {
      const res = await run({ serviceName: 'Consulta' }, makeCtx(null, { enabled: true, leadTimezone: 'America/Mexico_City' }));
      expect(res.slots[0]!.label).toMatch(/12:00 p\.?\s?m\./);
      expect(res.slots[0]!.label).not.toContain('hora de');
    });

    it('ignores the lead zone for a tenant that did not opt in (walk-in business)', async () => {
      const res = await run({ serviceName: 'Consulta' }, makeCtx(null, { enabled: false, leadTimezone: 'America/Cancun' }));
      expect(res.slots[0]!.label).toMatch(/12:00 p\.?\s?m\./);
      expect(res.slots[0]!.label).not.toContain('hora de');
    });

    it('falls back to the calendar clock while the lead is not located', async () => {
      const res = await run({ serviceName: 'Consulta' }, makeCtx(null, { enabled: true }));
      expect(res.slots[0]!.label).toMatch(/12:00 p\.?\s?m\./);
      expect(res.slots[0]!.label).not.toContain('hora de');
    });
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

// 0059: minimum notice. With 1 day the tool never queries today: the range is lifted to
// local midnight of tomorrow, and a today-only request returns a `too_soon` note without
// touching GHL. Clock pinned to 09:00 CDMX so "today" is unambiguous.
describe('getAvailability — minimum notice (0059)', () => {
  const NOW = Date.parse('2026-09-02T15:00:00Z'); // 09:00 Wed, America/Mexico_City
  const TOMORROW_MIDNIGHT = Date.parse('2026-09-03T06:00:00Z');
  let nowSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    nowSpy = vi.spyOn(Date, 'now').mockReturnValue(NOW);
  });
  afterEach(() => nowSpy.mockRestore());

  const noticeCtx = (bookingMinNoticeDays: number | null) => {
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
        bookingHorizonDays: null,
        bookingMinNoticeDays,
        leadTimezoneEnabled: false,
      },
    } as unknown as TenantContext;
    const turn = { ghlContactId: 'c1', ghlConversationId: 'conv1', channel: 'whatsapp' } as TurnContext;
    return { requestContext: { get: (k: string) => (k === 'tenant' ? tenant : k === 'turn' ? turn : undefined) } };
  };

  it('default range → GHL is asked from tomorrow 00:00 local, never from now', async () => {
    ghl.getAvailability.mockResolvedValue([{ start: '2026-09-03T16:30:00.000Z', end: '2026-09-03T17:00:00.000Z' }]);
    const res = await run({ serviceName: 'Consulta' }, noticeCtx(1));
    const fromArg = new Date(ghl.getAvailability.mock.calls[0]![1] as string).getTime();
    expect(fromArg).toBe(TOMORROW_MIDNIGHT);
    expect(res.slots).toHaveLength(1);
    expect(res.note).toContain('no se agenda para hoy');
  });

  it('a today-only request → too_soon note, GHL not called, event logged', async () => {
    const res = await run({ serviceName: 'Consulta', fromDate: '2026-09-02T09:00:00', toDate: '2026-09-02T19:00:00' }, noticeCtx(1));
    expect(res.slots).toEqual([]);
    expect(res.note).toContain('primer horario posible');
    expect(ghl.getAvailability).not.toHaveBeenCalled();
    expect(q.logBotEvent).toHaveBeenCalledWith('client1', 'conv1', 'availability_checked', expect.objectContaining({ outcome: 'too_soon', minNoticeDays: 1 }));
  });

  it('a request already starting tomorrow → no note, range untouched', async () => {
    ghl.getAvailability.mockResolvedValue([]);
    const res = await run({ serviceName: 'Consulta', fromDate: '2026-09-03T00:00:00', toDate: '2026-09-04T00:00:00' }, noticeCtx(1));
    expect(res.note).not.toContain('no se agenda para hoy');
    const fromArg = new Date(ghl.getAvailability.mock.calls[0]![1] as string).getTime();
    expect(fromArg).toBe(TOMORROW_MIDNIGHT);
  });

  it('NULL notice → queries from now, as before', async () => {
    ghl.getAvailability.mockResolvedValue([]);
    await run({ serviceName: 'Consulta' }, noticeCtx(null));
    const fromArg = new Date(ghl.getAvailability.mock.calls[0]![1] as string).getTime();
    expect(fromArg).toBe(NOW);
  });
});
