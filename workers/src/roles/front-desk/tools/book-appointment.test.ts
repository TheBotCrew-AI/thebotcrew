import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TenantContext, TurnContext } from '../../../core/types.js';

const ghl = { getContactPhone: vi.fn(), updateContactPhone: vi.fn(), bookAppointment: vi.fn() };
vi.mock('../../../ghl/client.js', () => ({ GhlClient: vi.fn(() => ghl) }));
vi.mock('../../../db/queries.js');

import * as q from '../../../db/queries.js';
import { bookAppointmentTool } from './book-appointment.js';

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
  },
} as unknown as TenantContext;

const turn = { ghlContactId: 'c1', ghlConversationId: 'conv1', channel: 'whatsapp' } as TurnContext;
const ctx = { requestContext: { get: (k: string) => (k === 'tenant' ? tenant : k === 'turn' ? turn : undefined) } };
const run = (input: { serviceName: string; startTime: string; whatsappPhone?: string }) =>
  (bookAppointmentTool.execute as (i: typeof input, c: typeof ctx) => Promise<{ booked: boolean; ghlAppointmentId?: string; message: string }>)(input, ctx);

const START = '2026-07-10T17:00:00.000Z';

beforeEach(() => {
  vi.clearAllMocks();
  ghl.getContactPhone.mockResolvedValue(undefined);
  ghl.updateContactPhone.mockResolvedValue(undefined);
  ghl.bookAppointment.mockResolvedValue({ ghlAppointmentId: 'appt1' });
  vi.mocked(q.logAppointment).mockResolvedValue({ appointmentId: 'a-uuid' } as never);
  vi.mocked(q.logEvent).mockResolvedValue({ eventId: 'e-uuid' } as never);
  vi.mocked(q.logBotEvent).mockResolvedValue(undefined);
});

describe('bookAppointment', () => {
  it('unknown service (no calendar) → not booked, GHL never called', async () => {
    const res = await run({ serviceName: 'NoExiste', startTime: START });
    expect(res.booked).toBe(false);
    expect(res.message).toContain('No tengo un calendario');
    expect(ghl.bookAppointment).not.toHaveBeenCalled();
  });

  it('happy path (no phone arg) → books, never touches the phone', async () => {
    const res = await run({ serviceName: 'Consulta', startTime: START });
    expect(ghl.bookAppointment).toHaveBeenCalledWith(
      expect.objectContaining({ calendarId: 'cal1', locationId: 'loc1', contactId: 'c1', startTime: START, title: 'Consulta' }),
    );
    expect(ghl.getContactPhone).not.toHaveBeenCalled();
    expect(ghl.updateContactPhone).not.toHaveBeenCalled();
    expect(res).toMatchObject({ booked: true, ghlAppointmentId: 'appt1' });
  });

  it('phone given + contact has NO phone → saves it (cleaned)', async () => {
    ghl.getContactPhone.mockResolvedValue(undefined);
    await run({ serviceName: 'Consulta', startTime: START, whatsappPhone: '+52 664 123 4567' });
    expect(ghl.updateContactPhone).toHaveBeenCalledWith('c1', '+526641234567');
  });

  it('phone given + contact ALREADY has a phone → never overwrites it (24h-window rule)', async () => {
    ghl.getContactPhone.mockResolvedValue('+5211111111');
    const res = await run({ serviceName: 'Consulta', startTime: START, whatsappPhone: '+526649999999' });
    expect(ghl.updateContactPhone).not.toHaveBeenCalled();
    expect(res.booked).toBe(true);
  });

  it('phone too short (<8 digits) → ignored, no phone lookup, still books', async () => {
    await run({ serviceName: 'Consulta', startTime: START, whatsappPhone: '12345' });
    expect(ghl.getContactPhone).not.toHaveBeenCalled();
    expect(ghl.updateContactPhone).not.toHaveBeenCalled();
    expect(ghl.bookAppointment).toHaveBeenCalledOnce();
  });

  it('phone save failure is non-blocking → booking still succeeds + event logged', async () => {
    ghl.getContactPhone.mockRejectedValue(new Error('ghl 500'));
    const res = await run({ serviceName: 'Consulta', startTime: START, whatsappPhone: '+526641234567' });
    expect(res.booked).toBe(true);
    expect(q.logBotEvent).toHaveBeenCalledWith('client1', 'conv1', 'db_error', expect.objectContaining({ stage: 'update_contact_phone' }));
  });

  it('GHL booking failure → not booked + booking_failed event', async () => {
    ghl.bookAppointment.mockRejectedValue(new Error('ghl 422'));
    const res = await run({ serviceName: 'Consulta', startTime: START });
    expect(res.booked).toBe(false);
    expect(q.logBotEvent).toHaveBeenCalledWith('client1', 'conv1', 'booking_failed', expect.objectContaining({ serviceName: 'Consulta', calendarId: 'cal1' }));
  });
});
