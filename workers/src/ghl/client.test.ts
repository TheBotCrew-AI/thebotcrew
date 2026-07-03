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
