import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TenantContext, TurnContext } from '../../../core/types.js';

const ghl = { getAppointment: vi.fn(), getContactAppointments: vi.fn() };
vi.mock('../../../ghl/client.js', () => ({ GhlClient: vi.fn(() => ghl) }));
vi.mock('../../../db/queries.js');

import * as q from '../../../db/queries.js';
import { lookupAppointmentTool } from './lookup-appointment.js';

const tenant = {
  tenantId: 't1',
  clientId: 'client1',
  ghlLocationId: 'loc1',
  config: { businessName: 'Demo', timezone: 'America/Mexico_City', tone: null, services: [], hours: {}, calendars: {}, faq: [], promptOverrides: {} },
} as unknown as TenantContext;
const turn = { ghlContactId: 'c1', ghlConversationId: 'conv1', channel: 'whatsapp' } as TurnContext;
const ctx = { requestContext: { get: (k: string) => (k === 'tenant' ? tenant : k === 'turn' ? turn : undefined) } };

type Out = { found: boolean; startTime?: string; label?: string; service?: string; message: string };
const run = () => (lookupAppointmentTool.execute as (i: Record<string, never>, c: typeof ctx) => Promise<Out>)({}, ctx);

// Far future: the resolver only serves FUTURE store rows (0049) — a near date rots
// into the past and silently reroutes every store-branch test through the GHL fallback.
const STORED = '2099-07-10T17:00:00.000Z';
const LIVE = '2099-07-11T18:00:00.000Z';
const appt = (o: Record<string, unknown> = {}) => ({ ghlAppointmentId: 'appt1', appointmentDatetime: STORED, serviceType: 'Consulta', action: 'booked', ...o });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(q.loadAppointmentLog).mockResolvedValue([appt()] as never);
  ghl.getAppointment.mockResolvedValue({ startTime: LIVE, status: 'confirmed' });
  ghl.getContactAppointments.mockResolvedValue([]);
});

describe('lookupAppointment', () => {
  it('no active appointment → not found', async () => {
    vi.mocked(q.loadAppointmentLog).mockResolvedValue([]);
    const res = await run();
    expect(res).toMatchObject({ found: false });
    expect(res.message).toContain('No encuentro una cita activa');
  });

  it('appointment cancelled in our store → not found', async () => {
    vi.mocked(q.loadAppointmentLog).mockResolvedValue([appt({ action: 'cancelled' })] as never);
    const res = await run();
    expect(res.found).toBe(false);
  });

  it('GHL says the appointment is cancelled → not found', async () => {
    ghl.getAppointment.mockResolvedValue({ status: 'Cancelled' });
    const res = await run();
    expect(res.found).toBe(false);
    expect(res.message).toContain('cancelada');
  });

  it('prefers the LIVE GHL time over the stored one', async () => {
    const res = await run();
    expect(res.found).toBe(true);
    expect(res.startTime).toBe(LIVE);
    expect(res.service).toBe('Consulta');
    expect(res.label).toBeDefined();
  });

  it('GHL read fails → falls back to the stored datetime', async () => {
    ghl.getAppointment.mockRejectedValue(new Error('ghl 500'));
    const res = await run();
    expect(res.found).toBe(true);
    expect(res.startTime).toBe(STORED);
  });

  it('store miss but GHL has an upcoming appointment (booked outside the bot) → found', async () => {
    vi.mocked(q.loadAppointmentLog).mockResolvedValue([]);
    const ghlTime = new Date(Date.now() + 20 * 86_400_000).toISOString();
    ghl.getContactAppointments.mockResolvedValue([{ id: 'ext-1', startTime: ghlTime, status: 'confirmed', calendarId: 'cal' }]);
    const res = await run();
    expect(res.found).toBe(true);
    expect(res.startTime).toBe(ghlTime);
    expect(ghl.getAppointment).not.toHaveBeenCalled(); // GHL-sourced → no redundant live read
  });

  it('store row with no datetime → resolver skips it to the GHL fallback; nothing there → not found', async () => {
    // Pre-0049 this row won the store branch and the tool died on the missing date;
    // now a dateless row is "inactive" and resolution falls through to GHL.
    vi.mocked(q.loadAppointmentLog).mockResolvedValue([appt({ appointmentDatetime: null })] as never);
    const res = await run();
    expect(res.found).toBe(false);
    expect(res.message).toContain('No encuentro una cita activa');
    expect(ghl.getContactAppointments).toHaveBeenCalled();
  });
});

describe('lookupAppointment — demo mode', () => {
  it('answers from the session simulated booking, never from the store/GHL', async () => {
    const demoTurn = { ghlContactId: 'c1', ghlConversationId: 'conv1', channel: 'whatsapp', activeRole: 'demo' } as TurnContext;
    const demoCtx = { requestContext: { get: (k: string) => (k === 'tenant' ? tenant : k === 'turn' ? demoTurn : undefined) } };
    vi.mocked(q.getActiveDemoSession).mockResolvedValue({
      id: 's1', activatedAt: '', expiresAt: '', messageBudget: 15, personaVersion: 1,
      leadData: {}, promptOverrides: {},
      simulatedBooking: { startTime: '2026-08-01T17:00:00.000Z', serviceName: 'Limpieza', label: 'sábado 1 de agosto, 11:00 a.m.' },
    });
    const exec = lookupAppointmentTool.execute as (i: Record<string, unknown>, c: unknown) => Promise<{ found: boolean; label?: string }>;
    const res = await exec({}, demoCtx);
    expect(res.found).toBe(true);
    expect(res.label).toBe('sábado 1 de agosto, 11:00 a.m.');
    expect(q.loadAppointmentLog).not.toHaveBeenCalled();
  });

  it('demo with no simulated booking → not found (never leaks a real appointment)', async () => {
    const demoTurn = { ghlContactId: 'c1', ghlConversationId: 'conv1', channel: 'whatsapp', activeRole: 'demo' } as TurnContext;
    const demoCtx = { requestContext: { get: (k: string) => (k === 'tenant' ? tenant : k === 'turn' ? demoTurn : undefined) } };
    vi.mocked(q.getActiveDemoSession).mockResolvedValue(null);
    const exec = lookupAppointmentTool.execute as (i: Record<string, unknown>, c: unknown) => Promise<{ found: boolean }>;
    const res = await exec({}, demoCtx);
    expect(res.found).toBe(false);
  });
});
