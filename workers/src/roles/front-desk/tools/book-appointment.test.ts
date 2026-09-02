import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { TenantContext, TurnContext } from '../../../core/types.js';

const ghl = {
  getContactPhone: vi.fn(),
  updateContactPhone: vi.fn(),
  bookAppointment: vi.fn(),
  getAvailability: vi.fn(),
  removeContactTags: vi.fn(),
  updateContactTimezone: vi.fn(),
  updateContactName: vi.fn(),
};
vi.mock('../../../ghl/client.js', () => ({ GhlClient: vi.fn(() => ghl) }));
vi.mock('../../../db/queries.js');
vi.mock('../../../meta/capi.js');

import * as q from '../../../db/queries.js';
import { queueCapiEvent } from '../../../meta/capi.js';
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

/** Same tenant, opted into lead-zone rendering, with the lead located in Cancún (-05:00). */
function leadCtx(leadTimezone?: string) {
  const t = { ...tenant, config: { ...(tenant.config as object), leadTimezoneEnabled: true } } as unknown as TenantContext;
  const tn = { ...turn, leadTimezone } as TurnContext;
  return { requestContext: { get: (k: string) => (k === 'tenant' ? t : k === 'turn' ? tn : undefined) } };
}
type LeadCtx = ReturnType<typeof leadCtx>;
const runWith = (input: { serviceName: string; startTime: string }, c: LeadCtx) =>
  (bookAppointmentTool.execute as (i: typeof input, c: LeadCtx) => Promise<{ booked: boolean; ghlAppointmentId?: string; message: string }>)(input, c);

beforeEach(() => {
  vi.clearAllMocks();
  ghl.getContactPhone.mockResolvedValue(undefined);
  ghl.updateContactPhone.mockResolvedValue(undefined);
  ghl.bookAppointment.mockResolvedValue({ ghlAppointmentId: 'appt1' });
  // By default the requested slot IS available (start === START), so validation passes.
  ghl.getAvailability.mockResolvedValue([{ start: START, end: START }]);
  ghl.removeContactTags.mockResolvedValue(undefined);
  ghl.updateContactTimezone.mockResolvedValue(undefined);
  ghl.updateContactName.mockResolvedValue(undefined);
  vi.mocked(q.logAppointment).mockResolvedValue({ appointmentId: 'a-uuid' } as never);
  vi.mocked(q.logEvent).mockResolvedValue({ eventId: 'e-uuid' } as never);
  vi.mocked(q.logBotEvent).mockResolvedValue(undefined);
  vi.mocked(q.resetReactivationRound).mockResolvedValue(undefined);
});

describe('bookAppointment', () => {
  // 0057: the lead picked the hour off a label rendered in THEIR clock, so an offset-less
  // startTime is read back in that same clock. 17:00Z is 12:00 p.m. in Cancún (-05:00) and
  // 11:00 a.m. in Mexico City (-06:00): typing the Cancún wall-clock must book, typing the
  // tenant's must not — the frame is the lead's now, and one of the two is a wrong hour.
  describe('lead timezone (0057)', () => {
    it('matches an offset-less wall-clock in the lead zone and confirms with a labelled time', async () => {
      const res = await runWith({ serviceName: 'Consulta', startTime: '2026-07-10T12:00:00' }, leadCtx('America/Cancun'));
      expect(res.booked).toBe(true);
      expect(ghl.bookAppointment).toHaveBeenCalledWith(expect.objectContaining({ startTime: START }));
      expect(res.message).toMatch(/12:00 p\.?\s?m\./);
      expect(res.message).toContain('hora de Cancún');
      expect(res.message).not.toContain(START);
    });

    it('refuses the tenant wall-clock for a lead reading another zone', async () => {
      const res = await runWith({ serviceName: 'Consulta', startTime: '2026-07-10T11:00:00' }, leadCtx('America/Cancun'));
      expect(res.booked).toBe(false);
      expect(ghl.bookAppointment).not.toHaveBeenCalled();
    });

    it('mirrors the lead zone onto the GHL contact BEFORE booking — the confirmation GHL sends renders in it', async () => {
      const res = await runWith({ serviceName: 'Consulta', startTime: '2026-07-10T12:00:00' }, leadCtx('America/Cancun'));
      expect(res.booked).toBe(true);
      expect(ghl.updateContactTimezone).toHaveBeenCalledWith('c1', 'America/Cancun');
      const syncAt = ghl.updateContactTimezone.mock.invocationCallOrder[0]!;
      const bookAt = ghl.bookAppointment.mock.invocationCallOrder[0]!;
      expect(syncAt).toBeLessThan(bookAt);
    });

    it('a contact-timezone sync that fails still books', async () => {
      ghl.updateContactTimezone.mockRejectedValue(new Error('401'));
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const res = await runWith({ serviceName: 'Consulta', startTime: '2026-07-10T12:00:00' }, leadCtx('America/Cancun'));
      expect(res.booked).toBe(true);
      expect(ghl.bookAppointment).toHaveBeenCalled();
      spy.mockRestore();
    });

    it('does not touch the contact while the lead is not located', async () => {
      await runWith({ serviceName: 'Consulta', startTime: '2026-07-10T11:00:00' }, leadCtx(undefined));
      expect(ghl.updateContactTimezone).not.toHaveBeenCalled();
    });

    it('keeps the tenant clock while the lead is not located', async () => {
      const res = await runWith({ serviceName: 'Consulta', startTime: '2026-07-10T11:00:00' }, leadCtx(undefined));
      expect(res.booked).toBe(true);
      expect(res.message).not.toContain('hora de');
    });
  });

  describe('contactName (the name the lead gave, saved at booking)', () => {
    const runNamed = (contactName?: string) =>
      (bookAppointmentTool.execute as (i: { serviceName: string; startTime: string; contactName?: string }, c: typeof ctx) => Promise<{ booked: boolean }>)(
        { serviceName: 'Consulta', startTime: START, contactName }, ctx,
      );

    it('writes first/last to the GHL contact BEFORE the booking POST (the confirmation greets by name)', async () => {
      const res = await runNamed('Karla Mendoza López');
      expect(res.booked).toBe(true);
      expect(ghl.updateContactName).toHaveBeenCalledWith('c1', { firstName: 'Karla', lastName: 'Mendoza López' });
      expect(ghl.updateContactName.mock.invocationCallOrder[0]!).toBeLessThan(ghl.bookAppointment.mock.invocationCallOrder[0]!);
    });

    it('omitted → the contact is left alone', async () => {
      await runNamed(undefined);
      expect(ghl.updateContactName).not.toHaveBeenCalled();
    });

    it('blank → the contact is left alone', async () => {
      await runNamed('   ');
      expect(ghl.updateContactName).not.toHaveBeenCalled();
    });

    it('a failed name write is logged and the booking still happens', async () => {
      ghl.updateContactName.mockRejectedValue(new Error('ghl 500'));
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const res = await runNamed('Karla');
      expect(res.booked).toBe(true);
      expect(ghl.bookAppointment).toHaveBeenCalled();
      expect(q.logBotEvent).toHaveBeenCalledWith('client1', 'conv1', 'db_error', expect.objectContaining({ stage: 'update_contact_name' }));
      spy.mockRestore();
    });

    it('demo: the roleplay name never touches the real contact', async () => {
      vi.mocked(q.getActiveDemoSession).mockResolvedValue(null);
      const demoTurn = { ...turn, activeRole: 'demo' } as TurnContext;
      const demoCtx = { requestContext: { get: (k: string) => (k === 'tenant' ? tenant : k === 'turn' ? demoTurn : undefined) } };
      await (bookAppointmentTool.execute as (i: { serviceName: string; startTime: string; contactName?: string }, c: typeof demoCtx) => Promise<unknown>)(
        { serviceName: 'Consulta', startTime: START, contactName: 'Paciente Falsa' }, demoCtx,
      );
      expect(ghl.updateContactName).not.toHaveBeenCalled();
      expect(ghl.bookAppointment).not.toHaveBeenCalled();
    });
  });

  it('a tenant that did not opt into lead timezones never writes the contact field', async () => {
    const res = await run({ serviceName: 'Consulta', startTime: START });
    expect(res.booked).toBe(true);
    expect(ghl.updateContactTimezone).not.toHaveBeenCalled();
  });

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
    // A real conversion wipes the ghost history (0049).
    expect(q.resetReactivationRound).toHaveBeenCalledWith('conv1');
  });

  it('calendar title carries name — treatment — campaign label when pinned to a variant', async () => {
    const t = {
      ...tenant,
      config: {
        ...(tenant.config as object),
        promptVariants: { a02: { calendarLabel: 'Jornada Bótox' } },
      },
    } as unknown as TenantContext;
    const tn = { ...turn, promptVariant: 'a02' } as TurnContext;
    const c = { requestContext: { get: (k: string) => (k === 'tenant' ? t : k === 'turn' ? tn : undefined) } };
    const res = await (bookAppointmentTool.execute as (i: unknown, cx: typeof c) => Promise<{ booked: boolean }>)(
      { serviceName: 'Consulta', startTime: START, contactName: 'Karla Mendoza', treatment: 'Bótox frente y entrecejo' },
      c,
    );
    expect(res.booked).toBe(true);
    expect(ghl.bookAppointment).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Karla Mendoza — Bótox frente y entrecejo — Jornada Bótox' }),
    );
  });

  it('a pinned variant with no calendarLabel adds no campaign suffix', async () => {
    const tn = { ...turn, promptVariant: 'a02', contactName: 'Karla' } as TurnContext;
    const c = { requestContext: { get: (k: string) => (k === 'tenant' ? tenant : k === 'turn' ? tn : undefined) } };
    await (bookAppointmentTool.execute as (i: unknown, cx: typeof c) => Promise<unknown>)(
      { serviceName: 'Consulta', startTime: START },
      c,
    );
    expect(ghl.bookAppointment).toHaveBeenCalledWith(expect.objectContaining({ title: 'Karla — Consulta' }));
  });

  it('a failed round reset is non-blocking → booking still succeeds', async () => {
    vi.mocked(q.resetReactivationRound).mockRejectedValue(new Error('db down'));
    const res = await run({ serviceName: 'Consulta', startTime: START });
    expect(res.booked).toBe(true);
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

  it('validates against real availability: unavailable slot → not booked, GHL booking never called', async () => {
    // getAvailability returns a DIFFERENT time than requested → no match.
    ghl.getAvailability.mockResolvedValue([{ start: '2026-07-10T18:00:00.000Z', end: '2026-07-10T18:00:00.000Z' }]);
    const res = await run({ serviceName: 'Consulta', startTime: START });
    expect(res.booked).toBe(false);
    expect(res.message).toContain('ya no está disponible');
    expect(ghl.bookAppointment).not.toHaveBeenCalled();
    expect(q.logBotEvent).toHaveBeenCalledWith('client1', 'conv1', 'booking_failed', expect.objectContaining({ reason: 'slot_unavailable' }));
  });

  it('availability lookup throws → not booked, surfaced as booking_failed(validate_availability)', async () => {
    ghl.getAvailability.mockRejectedValue(new Error('ghl 500'));
    const res = await run({ serviceName: 'Consulta', startTime: START });
    expect(res.booked).toBe(false);
    expect(ghl.bookAppointment).not.toHaveBeenCalled();
    expect(q.logBotEvent).toHaveBeenCalledWith('client1', 'conv1', 'booking_failed', expect.objectContaining({ stage: 'validate_availability' }));
  });

  describe('Meta CAPI hook (0048)', () => {
    it('a real booking queues appointment_booked (helper gates tenant/clid itself)', async () => {
      const res = await run({ serviceName: 'Consulta', startTime: START });
      expect(res.booked).toBe(true);
      expect(queueCapiEvent).toHaveBeenCalledWith({
        tenant,
        ghlConversationId: 'conv1',
        kind: 'appointment_booked',
        phone: null,
      });
    });

    it('a failed booking queues nothing', async () => {
      ghl.bookAppointment.mockRejectedValue(new Error('ghl 422'));
      await run({ serviceName: 'Consulta', startTime: START });
      expect(queueCapiEvent).not.toHaveBeenCalled();
    });

    it('an unavailable slot queues nothing', async () => {
      ghl.getAvailability.mockResolvedValue([{ start: '2026-07-10T18:00:00.000Z', end: '2026-07-10T18:00:00.000Z' }]);
      await run({ serviceName: 'Consulta', startTime: START });
      expect(queueCapiEvent).not.toHaveBeenCalled();
    });
  });

  // Regression: the demo bug where the lead picked 5:15 p.m. (Tijuana) but the model handed
  // bookAppointment an offset-less string. GHL read it as UTC and booked 10:15 a.m. The tool
  // must instead book the canonical slot string GHL returned (with the correct -07:00 offset).
  describe('timezone offset preservation (5:15 → 10:15 regression)', () => {
    const tijuanaTenant = {
      tenantId: 't1',
      clientId: 'client1',
      ghlLocationId: 'loc1',
      config: {
        businessName: 'The Bot Crew',
        timezone: 'America/Tijuana',
        tone: null,
        services: [{ name: 'Sesión de instalación', durationMin: 30 }],
        hours: {},
        calendars: { 'Sesión de instalación': 'cal-tj' },
        faq: [],
        promptOverrides: {},
      },
    } as unknown as TenantContext;
    const tjCtx = { requestContext: { get: (k: string) => (k === 'tenant' ? tijuanaTenant : k === 'turn' ? turn : undefined) } };
    const runTj = (input: { serviceName: string; startTime: string }) =>
      (bookAppointmentTool.execute as (i: typeof input, c: typeof tjCtx) => Promise<{ booked: boolean; ghlAppointmentId?: string; message: string }>)(input, tjCtx);

    const CANONICAL_515 = '2026-07-08T17:15:00-07:00';

    beforeEach(() => {
      // GHL offers the real 5:15 p.m. Tijuana slot, carrying the correct -07:00 offset.
      ghl.getAvailability.mockResolvedValue([
        { start: '2026-07-08T17:00:00-07:00', end: '2026-07-08T17:00:00-07:00' },
        { start: CANONICAL_515, end: CANONICAL_515 },
        { start: '2026-07-08T17:30:00-07:00', end: '2026-07-08T17:30:00-07:00' },
      ]);
    });

    it('offset-less model string (the bug) → books the canonical -07:00 slot, not UTC', async () => {
      // This is exactly what the model handed the tool in the demo: no timezone offset.
      const res = await runTj({ serviceName: 'Sesión de instalación', startTime: '2026-07-08T17:15:00' });
      expect(res.booked).toBe(true);
      expect(ghl.bookAppointment).toHaveBeenCalledWith(
        expect.objectContaining({ startTime: CANONICAL_515 }),
      );
      // The offset-less string parsed as UTC would be this — assert we did NOT send it.
      expect(ghl.bookAppointment).not.toHaveBeenCalledWith(
        expect.objectContaining({ startTime: '2026-07-08T17:15:00' }),
      );
      // And 10:15 a.m. Tijuana (17:15Z) never reaches GHL either.
      const sent = (ghl.bookAppointment.mock.calls[0]![0] as { startTime: string }).startTime;
      expect(new Date(sent).getTime()).toBe(new Date(CANONICAL_515).getTime());
    });

    it('model string that already carries the correct offset → still books the canonical slot', async () => {
      const res = await runTj({ serviceName: 'Sesión de instalación', startTime: CANONICAL_515 });
      expect(res.booked).toBe(true);
      expect(ghl.bookAppointment).toHaveBeenCalledWith(
        expect.objectContaining({ startTime: CANONICAL_515 }),
      );
    });
  });
});

describe('bookAppointment — demo mode (simulated booking)', () => {
  it('books only an exact simulated slot, stores it on the session, never calls GHL', async () => {
    const { simulatedSlots } = await import('./demo-sim.js');
    const tenant = {
      tenantId: 't1', clientId: 'client1',
      config: { businessName: 'X', timezone: 'America/Mexico_City', tone: null, services: [], hours: {}, calendars: {}, faq: [], promptOverrides: {} },
    } as unknown as TenantContext;
    const turn = { ghlContactId: 'c1', ghlConversationId: 'conv1', channel: 'whatsapp', activeRole: 'demo' } as TurnContext;
    const ctx = { requestContext: { get: (k: string) => (k === 'tenant' ? tenant : k === 'turn' ? turn : undefined) } };
    vi.mocked(q.getActiveDemoSession).mockResolvedValue({
      id: 's1', activatedAt: '', expiresAt: '', messageBudget: 15, personaVersion: 1,
      leadData: {}, promptOverrides: {}, simulatedBooking: null,
    });
    vi.mocked(q.setSimulatedBooking).mockResolvedValue(undefined);

    const slot = simulatedSlots('conv1', 'America/Mexico_City', Date.now())[0]!;
    const exec = bookAppointmentTool.execute as (i: Record<string, unknown>, c: unknown) => Promise<{ booked: boolean; message: string }>;

    // A made-up time is refused (same anti-hallucination rule as the real path).
    const bad = await exec({ serviceName: 'Limpieza', startTime: '2030-01-01T09:13:00-07:00' }, ctx);
    expect(bad.booked).toBe(false);

    const good = await exec({ serviceName: 'Limpieza', startTime: slot.start }, ctx);
    expect(good.booked).toBe(true);
    expect(q.setSimulatedBooking).toHaveBeenCalledWith('s1', expect.objectContaining({ startTime: slot.start, serviceName: 'Limpieza' }));
    expect(ghl.bookAppointment).not.toHaveBeenCalled(); // no real GHL traffic
    expect(ghl.getAvailability).not.toHaveBeenCalled();
    expect(q.logAppointment).not.toHaveBeenCalled(); // nothing in the real stats layer
    expect(q.resetReactivationRound).not.toHaveBeenCalled(); // a fake conversion resets nothing (0049)
    // A roleplayed booking is not a conversion — nothing goes to Meta (0048).
    expect(queueCapiEvent).not.toHaveBeenCalled();
  });
});

describe('bookAppointment — clears the `cita-cancelada` tag', () => {
  it('a real booking removes the tag (idempotent — GHL ignores an absent tag)', async () => {
    const res = await run({ serviceName: 'Consulta', startTime: START });
    expect(res.booked).toBe(true);
    expect(ghl.removeContactTags).toHaveBeenCalledWith('c1', ['cita-cancelada']);
  });

  it('a tag-removal failure never fails the booking', async () => {
    ghl.removeContactTags.mockRejectedValue(new Error('tags 500'));
    const res = await run({ serviceName: 'Consulta', startTime: START });
    expect(res.booked).toBe(true);
  });

  it('GHL booking failed → nothing to clear', async () => {
    ghl.bookAppointment.mockRejectedValue(new Error('ghl 500'));
    const res = await run({ serviceName: 'Consulta', startTime: START });
    expect(res.booked).toBe(false);
    expect(ghl.removeContactTags).not.toHaveBeenCalled();
  });
});

// 0059: minimum notice. The guard runs on the RESOLVED slot (the one GHL returned), so a
// free same-day slot is refused with `too_soon` even though availability says it is open.
// START is 17:00Z = 11:00 a.m. CDMX on 2026-07-10.
describe('bookAppointment — minimum notice (0059)', () => {
  const noticeCtx = (bookingMinNoticeDays: number | null) => {
    const t = { ...tenant, config: { ...(tenant.config as object), bookingMinNoticeDays } } as unknown as TenantContext;
    return { requestContext: { get: (k: string) => (k === 'tenant' ? t : k === 'turn' ? turn : undefined) } };
  };
  let nowSpy: ReturnType<typeof vi.spyOn>;
  afterEach(() => nowSpy?.mockRestore());

  it('a same-day slot GHL still offers → refused, booking_failed too_soon, nothing booked', async () => {
    nowSpy = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-07-10T15:00:00Z')); // 09:00 CDMX, same day as START
    const res = await runWith({ serviceName: 'Consulta', startTime: START }, noticeCtx(1));
    expect(res.booked).toBe(false);
    expect(res.message).toContain('demasiado pronto');
    expect(ghl.bookAppointment).not.toHaveBeenCalled();
    expect(q.logBotEvent).toHaveBeenCalledWith('client1', 'conv1', 'booking_failed', expect.objectContaining({ reason: 'too_soon', minNoticeDays: 1 }));
  });

  it('the same slot the day before → books (tomorrow is fine, even fewer than 24 h away)', async () => {
    nowSpy = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-07-10T04:00:00Z')); // 22:00 CDMX the previous evening
    const res = await runWith({ serviceName: 'Consulta', startTime: START }, noticeCtx(1));
    expect(res.booked).toBe(true);
    expect(ghl.bookAppointment).toHaveBeenCalledWith(expect.objectContaining({ startTime: START }));
  });

  it('NULL notice → a same-day slot books as before', async () => {
    nowSpy = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-07-10T15:00:00Z'));
    const res = await runWith({ serviceName: 'Consulta', startTime: START }, noticeCtx(null));
    expect(res.booked).toBe(true);
  });
});
