import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../db/queries.js');
vi.mock('./oauth.js');

import * as q from '../db/queries.js';
import { refreshAccessToken } from './oauth.js';
import { GhlClient } from './client.js';

const ok = (json: unknown) => ({ ok: true, status: 200, json: async () => json, text: async () => '' });
const err = (status: number, text = 'boom') => ({ ok: false, status, json: async () => ({}), text: async () => text });
const stubFetch = () => {
  const f = vi.fn();
  vi.stubGlobal('fetch', f);
  return f;
};
const headersOf = (f: ReturnType<typeof stubFetch>, i = 0) => (f.mock.calls[i]![1] as RequestInit).headers as Record<string, string>;
const bodyOf = (f: ReturnType<typeof stubFetch>, i = 0) => JSON.parse((f.mock.calls[i]![1] as RequestInit).body as string);

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  process.env.GHL_API_BASE = 'https://api.ghl';
  process.env.GHL_API_TOKEN = 'agency-token';
  vi.mocked(q.getOAuthToken).mockResolvedValue(null);
  vi.mocked(q.upsertOAuthToken).mockResolvedValue(undefined as never);
});

afterEach(() => {
  delete process.env.GHL_API_BASE;
  delete process.env.GHL_API_TOKEN;
});

const oauthRow = (expiresAtMs: number, accessToken = 'stored-at') =>
  ({ access_token: accessToken, refresh_token: 'rt', expires_at: new Date(expiresAtMs).toISOString() }) as never;

describe('GhlClient — access token resolution', () => {
  it('no tenantId → uses the agency token, never hits the OAuth store', async () => {
    const f = stubFetch();
    f.mockResolvedValue(ok({ contact: { phone: '+521234567' } }));
    await new GhlClient().getContactPhone('c1');
    expect(q.getOAuthToken).not.toHaveBeenCalled();
    expect(headersOf(f).Authorization).toBe('Bearer agency-token');
  });

  it('tenant with no stored token → falls back to the agency token', async () => {
    vi.mocked(q.getOAuthToken).mockResolvedValue(null);
    const f = stubFetch();
    f.mockResolvedValue(ok({ contact: { phone: '+521' } }));
    await new GhlClient('t1').getContactPhone('c1');
    expect(headersOf(f).Authorization).toBe('Bearer agency-token');
  });

  it('valid stored token → used as-is, no refresh', async () => {
    vi.mocked(q.getOAuthToken).mockResolvedValue(oauthRow(Date.now() + 3_600_000));
    const f = stubFetch();
    f.mockResolvedValue(ok({ contact: { phone: '+521' } }));
    await new GhlClient('t1').getContactPhone('c1');
    expect(refreshAccessToken).not.toHaveBeenCalled();
    expect(headersOf(f).Authorization).toBe('Bearer stored-at');
  });

  it('token within the refresh buffer → refreshes, persists, uses the fresh token', async () => {
    vi.mocked(q.getOAuthToken).mockResolvedValue(oauthRow(Date.now())); // expires now → inside buffer
    vi.mocked(refreshAccessToken).mockResolvedValue({ access_token: 'fresh-at', refresh_token: 'rt2', token_type: 'Bearer', expires_in: 3600, scope: '', locationId: 'loc1' });
    const f = stubFetch();
    f.mockResolvedValue(ok({ contact: { phone: '+521' } }));
    await new GhlClient('t1').getContactPhone('c1');
    expect(q.upsertOAuthToken).toHaveBeenCalledWith('t1', expect.objectContaining({ access_token: 'fresh-at' }));
    expect(headersOf(f).Authorization).toBe('Bearer fresh-at');
  });

  it('refresh failure → falls back to the (stale) stored token', async () => {
    vi.mocked(q.getOAuthToken).mockResolvedValue(oauthRow(Date.now()));
    vi.mocked(refreshAccessToken).mockRejectedValue(new Error('refresh 400'));
    const f = stubFetch();
    f.mockResolvedValue(ok({ contact: { phone: '+521' } }));
    await new GhlClient('t1').getContactPhone('c1');
    expect(headersOf(f).Authorization).toBe('Bearer stored-at');
  });
});

describe('GhlClient — getContactPhone', () => {
  it('returns a real phone', async () => {
    stubFetch().mockResolvedValue(ok({ contact: { phone: '+526641234567' } }));
    expect(await new GhlClient().getContactPhone('c1')).toBe('+526641234567');
  });

  it('rejects an email stored in the phone field', async () => {
    stubFetch().mockResolvedValue(ok({ contact: { phone: 'lead@example.com' } }));
    expect(await new GhlClient().getContactPhone('c1')).toBeUndefined();
  });

  it('non-ok response → undefined (never throws)', async () => {
    stubFetch().mockResolvedValue(err(404));
    expect(await new GhlClient().getContactPhone('c1')).toBeUndefined();
  });
});

describe('GhlClient — getContact / updateContactName', () => {
  it('reads first/last/name', async () => {
    stubFetch().mockResolvedValue(ok({ contact: { firstName: 'Ana', lastName: 'López', name: 'Ana López' } }));
    expect(await new GhlClient().getContact('c1')).toEqual({ firstName: 'Ana', lastName: 'López', name: 'Ana López' });
  });

  it('falls back to contactName when name is absent', async () => {
    stubFetch().mockResolvedValue(ok({ contact: { contactName: 'Gimnasio X' } }));
    expect((await new GhlClient().getContact('c1'))?.name).toBe('Gimnasio X');
  });

  it('returns the contact phone + email (the merge keys)', async () => {
    stubFetch().mockResolvedValue(ok({ contact: { name: 'Ana', phone: '+5215550000', email: 'ana@x.com' } }));
    expect(await new GhlClient().getContact('c1')).toEqual({ name: 'Ana', phone: '+5215550000', email: 'ana@x.com' });
  });

  it('drops an email stored in the phone field and a phone stored in the email field', async () => {
    stubFetch().mockResolvedValue(ok({ contact: { phone: 'ana@x.com', email: '+5215550000' } }));
    const c = await new GhlClient().getContact('c1');
    expect(c?.phone).toBeUndefined();
    expect(c?.email).toBeUndefined();
  });

  it('updateContactName sends firstName/lastName/name', async () => {
    const f = stubFetch();
    f.mockResolvedValue(ok({}));
    await new GhlClient().updateContactName('c1', { firstName: 'Ana', lastName: 'López' });
    expect(bodyOf(f)).toEqual({ firstName: 'Ana', lastName: 'López', name: 'Ana López' });
  });

  it('updateContactName throws on a non-ok response', async () => {
    stubFetch().mockResolvedValue(err(401));
    await expect(new GhlClient().updateContactName('c1', { firstName: 'A', lastName: '' })).rejects.toThrow(/updateContactName failed 401/);
  });

  it('updateContactTimezone PUTs only the timezone field', async () => {
    const f = stubFetch();
    f.mockResolvedValue(ok({}));
    await new GhlClient().updateContactTimezone('c1', 'America/Mexico_City');
    expect(f.mock.calls[0]![0]).toBe('https://api.ghl/contacts/c1');
    expect((f.mock.calls[0]![1] as RequestInit).method).toBe('PUT');
    expect(bodyOf(f)).toEqual({ timezone: 'America/Mexico_City' });
  });

  it('updateContactTimezone throws on a non-ok response', async () => {
    stubFetch().mockResolvedValue(err(422, 'bad tz'));
    await expect(new GhlClient().updateContactTimezone('c1', 'Nope/Zone')).rejects.toThrow(/updateContactTimezone failed 422/);
  });
});

describe('GhlClient — getAvailability', () => {
  it('flattens GHL date-keyed slots and skips metadata keys', async () => {
    stubFetch().mockResolvedValue(ok({
      '2026-06-11': { slots: ['2026-06-11T10:00:00Z', '2026-06-11T11:00:00Z'] },
      '2026-06-12': { slots: ['2026-06-12T09:00:00Z'] },
      traceId: 'abc',
    }));
    const slots = await new GhlClient().getAvailability('cal1', '2026-06-11', '2026-06-13');
    expect(slots).toHaveLength(3);
    expect(slots[0]).toEqual({ start: '2026-06-11T10:00:00Z', end: '2026-06-11T10:00:00Z' });
  });

  it('non-ok → throws', async () => {
    stubFetch().mockResolvedValue(err(500));
    await expect(new GhlClient().getAvailability('cal1', 'a', 'b')).rejects.toThrow(/getAvailability failed 500/);
  });
});

describe('GhlClient — sendMessage', () => {
  it.each([
    ['whatsapp', 'WhatsApp'],
    ['instagram', 'IG'],
    ['facebook', 'FB'],
  ] as const)('maps channel %s → GHL type %s and returns the message id', async (channel, type) => {
    const f = stubFetch();
    f.mockResolvedValue(ok({ messageId: 'm1' }));
    const res = await new GhlClient().sendMessage({ contactId: 'c1', channel, text: 'hola' });
    expect(bodyOf(f).type).toBe(type);
    expect(res).toEqual({ ghlMessageId: 'm1' });
  });

  it('merge recovery: 400 CONVERSATIONS_CONTACT_NOT_FOUND → re-resolves contact and retries', async () => {
    const f = stubFetch();
    f.mockResolvedValueOnce(err(400, 'CONVERSATIONS_CONTACT_NOT_FOUND')) // first post
      .mockResolvedValueOnce(ok({ contactId: 'c2' })) // getConversationContactId
      .mockResolvedValueOnce(ok({ messageId: 'm2' })); // retry post
    const res = await new GhlClient().sendMessage({ contactId: 'c1', channel: 'whatsapp', text: 'hola', conversationId: 'conv1' });
    expect(res).toEqual({ ghlMessageId: 'm2', resolvedContactId: 'c2' });
  });

  it('merge recovery: re-resolves the survivor by PHONE (search) and retries', async () => {
    const f = stubFetch();
    f.mockResolvedValueOnce(err(400, 'CONVERSATIONS_CONTACT_NOT_FOUND')) // first post (merged-away contact)
      .mockResolvedValueOnce(ok({ contacts: [{ id: 'survivor' }] }))     // POST /contacts/search by phone
      .mockResolvedValueOnce(ok({ messageId: 'm3' }));                    // retry post to survivor
    const res = await new GhlClient('t1').sendMessage({
      contactId: 'dead', channel: 'facebook', text: 'hola', phone: '+5215550000', conversationId: 'conv1',
    });
    expect(res).toEqual({ ghlMessageId: 'm3', resolvedContactId: 'survivor' });
    // The recovery search must hit /contacts/search with an exact phone filter.
    expect((f.mock.calls[1]![0] as string)).toContain('/contacts/search');
    expect(bodyOf(f, 1).filters).toEqual([{ field: 'phone', operator: 'eq', value: '+5215550000' }]);
    // Retry posted to the survivor, not the dead id.
    expect(bodyOf(f, 2).contactId).toBe('survivor');
  });

  it('merge recovery: PHONE search empty → falls back to EMAIL search', async () => {
    const f = stubFetch();
    f.mockResolvedValueOnce(err(400, 'CONVERSATIONS_CONTACT_NOT_FOUND')) // first post
      .mockResolvedValueOnce(ok({ contacts: [] }))                        // phone search: no hit
      .mockResolvedValueOnce(ok({ contacts: [{ id: 'survivor' }] }))     // email search: hit
      .mockResolvedValueOnce(ok({ messageId: 'm4' }));                    // retry post
    const res = await new GhlClient('t1').sendMessage({
      contactId: 'dead', channel: 'facebook', text: 'hola', phone: '+5215550000', email: 'ana@x.com', conversationId: 'conv1',
    });
    expect(res).toEqual({ ghlMessageId: 'm4', resolvedContactId: 'survivor' });
    expect(bodyOf(f, 2).filters).toEqual([{ field: 'email', operator: 'eq', value: 'ana@x.com' }]);
  });

  it('merge recovery: phone/email both miss → falls back to the conversation lookup', async () => {
    const f = stubFetch();
    f.mockResolvedValueOnce(err(400, 'CONVERSATIONS_CONTACT_NOT_FOUND')) // first post
      .mockResolvedValueOnce(ok({ contacts: [] }))                        // phone search: miss
      .mockResolvedValueOnce(ok({ conversation: { contactId: 'fromConv' } })) // getConversationContactId
      .mockResolvedValueOnce(ok({ messageId: 'm5' }));                    // retry post
    const res = await new GhlClient('t1').sendMessage({
      contactId: 'dead', channel: 'facebook', text: 'hola', phone: '+5215550000', conversationId: 'conv1',
    });
    expect(res).toEqual({ ghlMessageId: 'm5', resolvedContactId: 'fromConv' });
  });

  it('resolveContactByPhoneOrEmail: no keys → returns undefined without any network call', async () => {
    const f = stubFetch();
    expect(await new GhlClient('t1').resolveContactByPhoneOrEmail({})).toBeUndefined();
    expect(f).not.toHaveBeenCalled();
  });
});

describe('GhlClient — getAppointment', () => {
  it('unwraps a nested appointment and normalizes status', async () => {
    stubFetch().mockResolvedValue(ok({ appointment: { startTime: 'S', appointmentStatus: 'confirmed', title: 'T' } }));
    expect(await new GhlClient().getAppointment('a1')).toEqual({ startTime: 'S', status: 'confirmed', title: 'T' });
  });

  it('reads a flat payload and its status field', async () => {
    stubFetch().mockResolvedValue(ok({ startTime: 'S', status: 'cancelled' }));
    expect((await new GhlClient().getAppointment('a1')).status).toBe('cancelled');
  });
});

describe('GhlClient — getContactAppointments', () => {
  it('maps events and reads the misspelled appoinmentStatus field', async () => {
    stubFetch().mockResolvedValue(ok({
      events: [
        { id: 'e1', startTime: 'S1', endTime: 'E1', appointmentStatus: 'confirmed', calendarId: 'cal', title: 'Leo' },
        { id: 'e2', startTime: 'S2', appoinmentStatus: 'cancelled', calendarId: 'cal', deleted: true },
      ],
    }));
    const out = await new GhlClient().getContactAppointments('c1');
    expect(out).toEqual([
      { id: 'e1', startTime: 'S1', endTime: 'E1', status: 'confirmed', calendarId: 'cal', title: 'Leo', deleted: false },
      { id: 'e2', startTime: 'S2', endTime: undefined, status: 'cancelled', calendarId: 'cal', title: undefined, deleted: true },
    ]);
  });

  it('drops events with no id and returns [] on a non-ok response', async () => {
    const f = stubFetch();
    f.mockResolvedValueOnce(ok({ events: [{ startTime: 'S' }, { id: 'keep', startTime: 'S2' }] }));
    expect((await new GhlClient().getContactAppointments('c1')).map((e) => e.id)).toEqual(['keep']);
    f.mockResolvedValueOnce(err(404));
    expect(await new GhlClient().getContactAppointments('c1')).toEqual([]);
  });
});
