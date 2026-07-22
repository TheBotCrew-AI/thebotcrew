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

const STORED = '2026-07-10T17:00:00.000Z';
const LIVE = '2026-07-11T18:00:00.000Z';
const appt = (o: Record<string, unknown> = {}) => ({ ghlAppointmentId: 'appt1', appointmentDatetime: STORED, serviceType: 'Consulta', action: 'booked', ...o });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(q.loadLatestAppointment).mockResolvedValue(appt() as never);
  ghl.getAppointment.mockResolvedValue({ startTime: LIVE, status: 'confirmed' });
  ghl.getContactAppointments.mockResolvedValue([]);
});

describe('lookupAppointment', () => {
  it('no active appointment → not found', async () => {
    vi.mocked(q.loadLatestAppointment).mockResolvedValue(null);
    const res = await run();
    expect(res).toMatchObject({ found: false });
    expect(res.message).toContain('No encuentro una cita activa');
  });

  it('appointment cancelled in our store → not found', async () => {
    vi.mocked(q.loadLatestAppointment).mockResolvedValue(appt({ action: 'cancelled' }) as never);
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
    vi.mocked(q.loadLatestAppointment).mockResolvedValue(null);
    const ghlTime = new Date(Date.now() + 20 * 86_400_000).toISOString();
    ghl.getContactAppointments.mockResolvedValue([{ id: 'ext-1', startTime: ghlTime, status: 'confirmed', calendarId: 'cal' }]);
    const res = await run();
    expect(res.found).toBe(true);
    expect(res.startTime).toBe(ghlTime);
    expect(ghl.getAppointment).not.toHaveBeenCalled(); // GHL-sourced → no redundant live read
  });

  it('no stored time AND GHL read fails → cannot read date, not found', async () => {
    vi.mocked(q.loadLatestAppointment).mockResolvedValue(appt({ appointmentDatetime: null }) as never);
    ghl.getAppointment.mockRejectedValue(new Error('ghl 500'));
    const res = await run();
    expect(res.found).toBe(false);
    expect(res.message).toContain('no pude leer la fecha');
  });
});
