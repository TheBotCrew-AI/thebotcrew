import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TenantContext } from '../core/types.js';

vi.mock('../db/queries.js');
const ghl = { getContactAppointments: vi.fn(), resolveContactByPhoneOrEmail: vi.fn(), removeContactTags: vi.fn(), addContactTags: vi.fn(), getContact: vi.fn(), updateContactCustomFields: vi.fn() };
vi.mock('../ghl/client.js', () => ({ GhlClient: vi.fn(() => ghl) }));

import * as q from '../db/queries.js';
import { handleAppointmentWebhook } from './appointment-webhook-handler.js';

const SECRET = 's3cret';
const AUTH = `Bearer ${SECRET}`;

const tenant = {
  tenantId: 't1',
  clientId: 'client1',
  ghlLocationId: 'loc1',
  awaitingHumanTag: 'esperando-agenda',
  config: { businessName: 'MADI', timezone: 'America/Tijuana' },
} as unknown as TenantContext;

const payload = (o: Record<string, unknown> = {}) => ({
  locationId: 'loc1',
  contactId: 'c1',
  appointmentId: 'appt-9',
  ...o,
});

const run = (p: unknown = payload(), auth: string | null = AUTH, secret: string | undefined = SECRET) =>
  handleAppointmentWebhook(p, auth, secret);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(q.loadTenantConfig).mockResolvedValue(tenant);
  vi.mocked(q.appointmentActionLogged).mockResolvedValue(false);
  vi.mocked(q.logAppointment).mockResolvedValue({ appointmentId: 'row-1' });
  vi.mocked(q.getLatestConversationByContact).mockResolvedValue({ id: 'cv1', ghlConversationId: 'conv1' });
  vi.mocked(q.cancelFollowUps).mockResolvedValue(undefined);
  vi.mocked(q.resetReactivationRound).mockResolvedValue(undefined);
  vi.mocked(q.setAwaitingHumanByContact).mockResolvedValue(1);
  ghl.removeContactTags.mockResolvedValue(undefined);
  ghl.addContactTags.mockResolvedValue(undefined);
  ghl.getContact.mockResolvedValue({ tags: [] });
  ghl.updateContactCustomFields.mockResolvedValue(undefined);
  vi.mocked(q.appointmentStatusLogged).mockResolvedValue(false);
  vi.mocked(q.logBotEvent).mockResolvedValue(undefined);
  ghl.getContactAppointments.mockResolvedValue([
    { id: 'appt-9', startTime: '2099-08-09T16:00:00-07:00', title: 'Depilación láser' },
    { id: 'other', startTime: '2099-01-01T10:00:00-07:00', title: 'Otra' },
  ]);
});

describe('handleAppointmentWebhook — auth (fails closed)', () => {
  it('no secret configured → 401 even with a matching header', async () => {
    // Called directly: run()'s default param would swallow an explicit undefined.
    expect((await handleAppointmentWebhook(payload(), AUTH, undefined)).status).toBe(401);
  });

  it('wrong or missing bearer → 401, nothing touched', async () => {
    expect((await run(payload(), 'Bearer nope')).status).toBe(401);
    expect((await run(payload(), null)).status).toBe(401);
    expect(q.logAppointment).not.toHaveBeenCalled();
  });
});

describe('handleAppointmentWebhook — the DEFAULT GHL workflow payload', () => {
  // The workflow's Custom Webhook ships its default payload: contact fields at
  // root (contact_id, phone, email), the sub-account under `location`, and the
  // appointment under `calendar`. The operator only adds `action` as custom data.
  const ghlDefault = (o: Record<string, unknown> = {}) => ({
    first_name: 'Ana',
    contact_id: 'c1',
    phone: '+526641234567',
    email: 'ana@x.com',
    location: { id: 'loc1', name: 'MADI' },
    calendar: {
      id: 'cal-1',
      appointmentId: 'appt-9',
      // Wall-clock in the calendar tz, NO offset — must be ignored (the 5:15→10:15 class).
      startTime: '2099-08-09T16:00:00',
      selectedTimezone: 'America/Tijuana',
      title: 'lo que diga el merge field',
    },
    ...o,
  });

  it('parses location.id / contact_id / calendar.appointmentId; datetime still comes from GHL', async () => {
    const res = await run(ghlDefault());
    expect(res.status).toBe(200);
    expect(q.logAppointment).toHaveBeenCalledWith(
      expect.objectContaining({
        p_ghl_contact_id: 'c1',
        p_ghl_appointment_id: 'appt-9',
        p_action: 'booked',
        // The offset-carrying instant from getContactAppointments, NOT calendar.startTime.
        p_appointment_datetime: '2099-08-09T16:00:00-07:00',
      }),
    );
    expect(ghl.resolveContactByPhoneOrEmail).not.toHaveBeenCalled();
  });

  it('the custom-data `action` field routes cancelled/rescheduled', async () => {
    await run(ghlDefault({ action: 'cancelled' }));
    expect(q.logAppointment).toHaveBeenCalledWith(expect.objectContaining({ p_action: 'cancelled' }));
  });

  it('GHL nests the custom data under `customData` — that is where the real action lives', async () => {
    // The 2026-10-14 Heriberto test: three workflows with action booked/rescheduled/cancelled
    // all landed as `booked` because only the root key was read, and the dedup ate the rest.
    await run(ghlDefault({ customData: { action: 'rescheduled' } }));
    expect(q.logAppointment).toHaveBeenCalledWith(expect.objectContaining({ p_action: 'rescheduled' }));
  });

  it('a root `action` (manual replay) outranks `customData.action`', async () => {
    await run(ghlDefault({ action: 'cancelled', customData: { action: 'booked' } }));
    expect(q.logAppointment).toHaveBeenCalledWith(expect.objectContaining({ p_action: 'cancelled' }));
  });

  it('no contact_id → falls back to phone/email search (the merge-recovery path)', async () => {
    ghl.resolveContactByPhoneOrEmail.mockResolvedValue('c-found');
    const res = await run(ghlDefault({ contact_id: undefined }));
    expect(res.status).toBe(200);
    expect(ghl.resolveContactByPhoneOrEmail).toHaveBeenCalledWith({ phone: '+526641234567', email: 'ana@x.com' });
    expect(q.logAppointment).toHaveBeenCalledWith(expect.objectContaining({ p_ghl_contact_id: 'c-found' }));
  });

  it('no contact resolvable at all → 200 ignored (no GHL retry storm), no row', async () => {
    ghl.resolveContactByPhoneOrEmail.mockResolvedValue(undefined);
    const res = await run(ghlDefault({ contact_id: undefined, phone: undefined, email: undefined }));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ignored: 'no contact id and search found none' });
    expect(q.logAppointment).not.toHaveBeenCalled();
  });
});

describe('handleAppointmentWebhook — validation & routing', () => {
  it('missing location/appointment ids → 400', async () => {
    expect((await run(payload({ appointmentId: '  ' }))).status).toBe(400);
    expect((await run({})).status).toBe(400);
  });

  it('unknown action → 400', async () => {
    expect((await run(payload({ action: 'no-showed' }))).status).toBe(400);
  });

  it('unknown tenant → 200 ignored (no retry storm from GHL)', async () => {
    vi.mocked(q.loadTenantConfig).mockResolvedValue(null);
    const res = await run();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ignored: 'unknown or inactive tenant' });
    expect(q.logAppointment).not.toHaveBeenCalled();
  });
});

describe('handleAppointmentWebhook — the staff booking lands in the store', () => {
  it('logs with GHL-sourced datetime/title, never with payload dates', async () => {
    // Even if the workflow leaks a merge-field date, it is ignored — GHL is the truth.
    const res = await run(payload({ startTime: 'agosto 9, 4:00 pm' }));
    expect(res.status).toBe(200);
    expect(q.logAppointment).toHaveBeenCalledWith({
      p_client_id: 'client1',
      p_ghl_contact_id: 'c1',
      p_action: 'booked',
      p_appointment_datetime: '2099-08-09T16:00:00-07:00',
      p_service_type: 'Depilación láser',
      p_source: 'ghl-workflow',
      p_ghl_appointment_id: 'appt-9',
    });
  });

  it('duplicate (bot already logged it, or a workflow retry) → skipped', async () => {
    vi.mocked(q.appointmentActionLogged).mockResolvedValue(true);
    const res = await run();
    expect(res.body).toMatchObject({ ignored: 'already logged' });
    expect(q.logAppointment).not.toHaveBeenCalled();
    expect(q.resetReactivationRound).not.toHaveBeenCalled();
  });

  it('appointment missing in GHL → still logged, null datetime (the count survives)', async () => {
    ghl.getContactAppointments.mockResolvedValue([]);
    await run();
    expect(q.logAppointment).toHaveBeenCalledWith(
      expect.objectContaining({ p_appointment_datetime: null, p_service_type: null }),
    );
  });

  it('a GHL read failure is non-fatal for the stat', async () => {
    ghl.getContactAppointments.mockRejectedValue(new Error('ghl 500'));
    const res = await run();
    expect(res.status).toBe(200);
    expect(q.logAppointment).toHaveBeenCalled();
  });
});

describe('handleAppointmentWebhook — 0049 parity with a bot booking', () => {
  it('booked → cancels pending nudges + resets the reactivation round', async () => {
    await run();
    expect(q.cancelFollowUps).toHaveBeenCalledWith('cv1');
    expect(q.resetReactivationRound).toHaveBeenCalledWith('conv1');
  });

  it('booked → clears awaiting_human and removes the esperando-agenda tag (the loop closes itself)', async () => {
    // Staff booking IS the "I've handled this" action; before this the tag stayed on
    // until someone remembered, and the bot kept re-flagging resolved requests.
    await run();
    expect(q.setAwaitingHumanByContact).toHaveBeenCalledWith('c1', false);
    expect(ghl.removeContactTags).toHaveBeenCalledWith('c1', ['esperando-agenda']);
  });

  it('tenant without an awaiting-human tag → the awaiting-human machinery is not touched', async () => {
    vi.mocked(q.loadTenantConfig).mockResolvedValue({ ...tenant, awaitingHumanTag: null } as never);
    await run();
    expect(q.setAwaitingHumanByContact).not.toHaveBeenCalled();
    expect(ghl.removeContactTags).not.toHaveBeenCalledWith('c1', ['esperando-agenda']);
    // `cita-cancelada` is platform-wide (no per-tenant tag), so its clearing still runs.
    expect(ghl.removeContactTags).toHaveBeenCalledWith('c1', ['cita-cancelada']);
  });

  it('tag-clearing failures are non-fatal', async () => {
    vi.mocked(q.setAwaitingHumanByContact).mockRejectedValue(new Error('db down'));
    ghl.removeContactTags.mockRejectedValue(new Error('ghl 500'));
    const res = await run();
    expect(res.status).toBe(200);
    expect(q.logAppointment).toHaveBeenCalled();
  });

  it('cancelled → logs the action but neither cancels nudges nor resets rounds nor touches the awaiting-human tag', async () => {
    await run(payload({ action: 'cancelled' }));
    expect(q.logAppointment).toHaveBeenCalledWith(expect.objectContaining({ p_action: 'cancelled' }));
    expect(q.cancelFollowUps).not.toHaveBeenCalled();
    expect(q.resetReactivationRound).not.toHaveBeenCalled();
    expect(q.setAwaitingHumanByContact).not.toHaveBeenCalled();
    expect(ghl.removeContactTags).not.toHaveBeenCalled();
  });

  it('a contact with no conversation yet (walk-in) still gets the stat row', async () => {
    vi.mocked(q.getLatestConversationByContact).mockResolvedValue(null);
    const res = await run();
    expect(res.status).toBe(200);
    expect(q.logAppointment).toHaveBeenCalled();
    expect(q.cancelFollowUps).not.toHaveBeenCalled();
  });

  it('parity failures are non-fatal — the appointment row is the must-have', async () => {
    vi.mocked(q.cancelFollowUps).mockRejectedValue(new Error('db down'));
    const res = await run();
    expect(res.status).toBe(200);
    expect(q.logAppointment).toHaveBeenCalled();
  });
});

describe('handleAppointmentWebhook — tag writes are awaited (the route has no waitUntil)', () => {
  it('the cancelled tag write completes BEFORE the response (a detached promise would be killed)', async () => {
    let settled = false;
    ghl.addContactTags.mockImplementation(() => new Promise<void>((r) => setTimeout(() => { settled = true; r(); }, 20)));
    await run(payload({ action: 'cancelled' }));
    expect(settled).toBe(true);
  });

  it('a failing tag write is logged and the webhook still answers 200', async () => {
    ghl.addContactTags.mockRejectedValue(new Error('ghl down'));
    ghl.removeContactTags.mockRejectedValue(new Error('ghl down'));
    expect((await run(payload({ action: 'cancelled' }))).status).toBe(200);
    expect((await run(payload({ action: 'booked' }))).status).toBe(200);
  });
});

describe('handleAppointmentWebhook — the `cita-cancelada` tag (parity with the bot tools)', () => {
  it('a staff cancellation tags the contact', async () => {
    await run(payload({ action: 'cancelled' }));
    expect(ghl.addContactTags).toHaveBeenCalledWith('c1', ['cita-cancelada']);
  });

  it('a staff booking clears it (alongside the awaiting-human tag)', async () => {
    await run();
    expect(ghl.removeContactTags).toHaveBeenCalledWith('c1', ['cita-cancelada']);
    expect(ghl.addContactTags).not.toHaveBeenCalled();
  });

  it('rescheduled → neither adds nor removes it', async () => {
    await run(payload({ action: 'rescheduled' }));
    expect(ghl.addContactTags).not.toHaveBeenCalled();
    expect(ghl.removeContactTags).not.toHaveBeenCalledWith('c1', ['cita-cancelada']);
  });

  it('a duplicate delivery never re-tags', async () => {
    vi.mocked(q.appointmentActionLogged).mockResolvedValue(true);
    await run(payload({ action: 'cancelled' }));
    expect(ghl.addContactTags).not.toHaveBeenCalled();
  });

  it('tag failures are non-fatal for the stat row', async () => {
    ghl.addContactTags.mockRejectedValue(new Error('ghl 500'));
    const res = await run(payload({ action: 'cancelled' }));
    expect(res.status).toBe(200);
    expect(q.logAppointment).toHaveBeenCalledWith(expect.objectContaining({ p_action: 'cancelled' }));
  });
});

describe('handleAppointmentWebhook — funnel tags from appointment status (0074)', () => {
  const FUNNEL = {
    enabled: true,
    calendars: {
      'cal-val': { slug: 'valoracion', kind: 'assessment' },
      'cal-botox': { slug: 'botox', kind: 'treatment' },
    },
    fields: { last_visit: 'fld-visit', last_treatment: { botox: 'fld-botox' } },
  };
  const funnelTenant = { ...tenant, config: { ...tenant.config, funnelTags: FUNNEL } } as unknown as TenantContext;
  const live = (o: Record<string, unknown>) =>
    ghl.getContactAppointments.mockResolvedValue([{ id: 'appt-9', startTime: '2026-10-15T16:00:00-07:00', title: 'X', calendarId: 'cal-val', status: 'confirmed', ...o }]);

  beforeEach(() => {
    vi.mocked(q.loadTenantConfig).mockResolvedValue(funnelTenant);
  });

  it('showed on the assessment → valorado + ultima-visita (date of the CITA, tenant clock), no store row', async () => {
    live({ status: 'showed' });
    ghl.getContact.mockResolvedValue({ tags: ['agendo:valoracion', 'noshow:valoracion'] });
    const res = await run(payload({ action: 'showed' }));
    expect(res.body).toMatchObject({ ok: true, funnel: true });
    expect(q.logAppointment).not.toHaveBeenCalled();
    expect(ghl.addContactTags).toHaveBeenCalledWith('c1', ['valorado']);
    expect(ghl.removeContactTags).toHaveBeenCalledWith('c1', ['noshow:valoracion']);
    expect(ghl.updateContactCustomFields).toHaveBeenCalledWith('c1', [{ id: 'fld-visit', value: '2026-10-15' }]);
    expect(q.logBotEvent).toHaveBeenCalledWith('client1', 'conv1', 'funnel_tagged', expect.objectContaining({ status: 'showed', slug: 'valoracion' }));
    expect(q.logBotEvent).toHaveBeenCalledWith('client1', 'conv1', 'appointment_status', { appointmentId: 'appt-9', status: 'showed', calendarId: 'cal-val' });
  });

  it('showed on a treatment → paciente:<slug>, drops interes:/cotizo:, both date fields', async () => {
    live({ status: 'showed', calendarId: 'cal-botox' });
    ghl.getContact.mockResolvedValue({ tags: ['interes:botox', 'cotizo:botox', 'interes:laser-co2'] });
    await run(payload({ action: 'showed' }));
    expect(ghl.addContactTags).toHaveBeenCalledWith('c1', ['paciente:botox']);
    expect(ghl.removeContactTags).toHaveBeenCalledWith('c1', ['interes:botox', 'cotizo:botox']);
    expect(ghl.updateContactCustomFields).toHaveBeenCalledWith('c1', [{ id: 'fld-botox', value: '2026-10-15' }, { id: 'fld-visit', value: '2026-10-15' }]);
  });

  it('noshow → noshow:<slug>, nothing removed, no fields', async () => {
    live({ status: 'noshow' });
    await run(payload({ action: 'noshow' }));
    expect(ghl.addContactTags).toHaveBeenCalledWith('c1', ['noshow:valoracion']);
    expect(ghl.removeContactTags).not.toHaveBeenCalled();
    expect(ghl.updateContactCustomFields).not.toHaveBeenCalled();
  });

  it('confirmed → the scheduled step: agendo:valoracion + objections cleared; booked uses the same key', async () => {
    live({ status: 'confirmed' });
    ghl.getContact.mockResolvedValue({ tags: ['objecion:precio'] });
    await run(payload({ action: 'confirmed' }));
    expect(ghl.addContactTags).toHaveBeenCalledWith('c1', ['agendo:valoracion']);
    expect(ghl.removeContactTags).toHaveBeenCalledWith('c1', ['objecion:precio']);
    expect(q.appointmentStatusLogged).toHaveBeenCalledWith('client1', 'appt-9', 'scheduled');
  });

  it('booked (the store path) ALSO runs the scheduled step, after the row', async () => {
    live({ status: 'confirmed' });
    await run(payload({ action: 'booked' }));
    expect(q.logAppointment).toHaveBeenCalled();
    expect(ghl.addContactTags).toHaveBeenCalledWith('c1', ['agendo:valoracion']);
  });

  it('GHL is the truth: the workflow says showed, GHL says noshow → noshow is applied', async () => {
    live({ status: 'noshow' });
    await run(payload({ action: 'showed' }));
    expect(ghl.addContactTags).toHaveBeenCalledWith('c1', ['noshow:valoracion']);
    expect(ghl.addContactTags).not.toHaveBeenCalledWith('c1', expect.arrayContaining(['valorado']));
  });

  it('no live appointment → nothing written, funnel_error logged (a hint alone never tags)', async () => {
    ghl.getContactAppointments.mockResolvedValue([]);
    await run(payload({ action: 'showed' }));
    expect(ghl.addContactTags).not.toHaveBeenCalled();
    expect(q.logBotEvent).toHaveBeenCalledWith('client1', 'conv1', 'funnel_error', expect.objectContaining({ reason: 'no_live_appointment' }));
  });

  it('duplicate (same appointment + status already applied) → skipped, no writes', async () => {
    live({ status: 'showed' });
    vi.mocked(q.appointmentStatusLogged).mockResolvedValue(true);
    await run(payload({ action: 'showed' }));
    expect(ghl.addContactTags).not.toHaveBeenCalled();
    expect(q.logBotEvent).not.toHaveBeenCalledWith('client1', 'conv1', 'funnel_tagged', expect.anything());
  });

  it('a calendar outside the map → ignored, no writes, no invented slug', async () => {
    live({ status: 'showed', calendarId: 'cal-unknown' });
    await run(payload({ action: 'showed' }));
    expect(ghl.addContactTags).not.toHaveBeenCalled();
    expect(q.logBotEvent).not.toHaveBeenCalledWith('client1', 'conv1', 'funnel_tagged', expect.anything());
  });

  it('a tag already on the contact is not re-sent', async () => {
    live({ status: 'showed' });
    ghl.getContact.mockResolvedValue({ tags: ['valorado'] });
    await run(payload({ action: 'showed' }));
    expect(ghl.addContactTags).not.toHaveBeenCalled();
    // ...but the step still completes (date field + dedupe key), so a replay stops here.
    expect(ghl.updateContactCustomFields).toHaveBeenCalled();
    expect(q.logBotEvent).toHaveBeenCalledWith('client1', 'conv1', 'appointment_status', expect.anything());
  });

  it('a GHL write failure is retried once; a second failure logs funnel_error and leaves NO dedupe key', async () => {
    live({ status: 'showed' });
    ghl.addContactTags.mockRejectedValueOnce(new Error('503')).mockResolvedValueOnce(undefined);
    await run(payload({ action: 'showed' }));
    expect(ghl.addContactTags).toHaveBeenCalledTimes(2);
    expect(q.logBotEvent).toHaveBeenCalledWith('client1', 'conv1', 'appointment_status', expect.anything());

    vi.clearAllMocks();
    vi.mocked(q.loadTenantConfig).mockResolvedValue(funnelTenant);
    vi.mocked(q.getLatestConversationByContact).mockResolvedValue({ id: 'cv1', ghlConversationId: 'conv1' });
    vi.mocked(q.appointmentStatusLogged).mockResolvedValue(false);
    ghl.getContact.mockResolvedValue({ tags: [] });
    live({ status: 'showed' });
    ghl.addContactTags.mockRejectedValue(new Error('503'));
    await run(payload({ action: 'showed' }));
    expect(q.logBotEvent).toHaveBeenCalledWith('client1', 'conv1', 'funnel_error', expect.objectContaining({ reason: 'ghl_write_failed' }));
    expect(q.logBotEvent).not.toHaveBeenCalledWith('client1', 'conv1', 'appointment_status', expect.anything());
  });

  it('tenant without funnel_tags → status actions are accepted and do nothing', async () => {
    vi.mocked(q.loadTenantConfig).mockResolvedValue(tenant);
    live({ status: 'showed' });
    const res = await run(payload({ action: 'showed' }));
    expect(res.status).toBe(200);
    expect(ghl.addContactTags).not.toHaveBeenCalled();
  });

  it('cancelled keeps its 0049 behaviour and touches no funnel tag', async () => {
    live({ status: 'cancelled' });
    await run(payload({ action: 'cancelled' }));
    expect(ghl.addContactTags).toHaveBeenCalledWith('c1', ['cita-cancelada']);
    expect(ghl.addContactTags).toHaveBeenCalledTimes(1);
  });
});

