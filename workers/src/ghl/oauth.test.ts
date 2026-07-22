import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getInstallUrl, exchangeCode, refreshAccessToken } from './oauth.js';

const ok = (json: unknown) => ({ ok: true, status: 200, json: async () => json, text: async () => '' });
const err = (status: number, text = 'boom') => ({ ok: false, status, json: async () => ({}), text: async () => text });
const stubFetch = () => {
  const f = vi.fn();
  vi.stubGlobal('fetch', f);
  return f;
};
const formBody = (f: ReturnType<typeof stubFetch>, i = 0) =>
  Object.fromEntries(new URLSearchParams((f.mock.calls[i]![1] as RequestInit).body as string));

const tokenResponse = { access_token: 'at', refresh_token: 'rt', token_type: 'Bearer', expires_in: 3600, scope: 'x', locationId: 'loc1' };

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  process.env.GHL_CLIENT_ID = 'cid';
  process.env.GHL_CLIENT_SECRET = 'secret';
  process.env.GHL_OAUTH_REDIRECT_URI = 'https://app/cb';
});

afterEach(() => {
  delete process.env.GHL_CLIENT_ID;
  delete process.env.GHL_CLIENT_SECRET;
  delete process.env.GHL_OAUTH_REDIRECT_URI;
});

describe('getInstallUrl', () => {
  it('builds the marketplace auth URL with client_id, redirect, scope and state', () => {
    const url = new URL(getInstallUrl('state-123'));
    expect(url.origin + url.pathname).toBe('https://marketplace.gohighlevel.com/oauth/chooselocation');
    expect(url.searchParams.get('client_id')).toBe('cid');
    expect(url.searchParams.get('redirect_uri')).toBe('https://app/cb');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('state')).toBe('state-123');
    expect(url.searchParams.get('scope')).toContain('contacts.write');
  });

  it('requests conversations.readonly — merge recovery reads the conversation to re-resolve a merged-away contact', () => {
    // Regression guard: without this scope GET /conversations/{id} 401s, so
    // GhlClient.getConversationContactId returns undefined and contact-merge recovery
    // on send fails — Facebook Instant-Form leads (contact merged by phone) go unanswered.
    const scope = new URL(getInstallUrl('s')).searchParams.get('scope') ?? '';
    expect(scope.split(' ')).toContain('conversations.readonly');
  });

  it('requests calendars.readonly — onboarding lists the location calendars to fill tenant_config.calendars', () => {
    // Regression guard: calendars/events.write can book/move/cancel and read /free-slots,
    // but GET /calendars?locationId= 401s "not authorized for this scope" without this one.
    // Losing it means every new tenant's calendar id has to be copied by hand from the GHL UI.
    const scope = new URL(getInstallUrl('s')).searchParams.get('scope') ?? '';
    expect(scope.split(' ')).toContain('calendars.readonly');
  });

  it('requests calendars/events.readonly — getAppointment reads one appointment live', () => {
    // Regression guard: calendars/events.write cannot READ an appointment. Without this scope
    // GET /calendars/events/appointments/{id} 401s, lookupAppointment swallows it and serves the
    // stored datetime — so an appointment moved or cancelled in the GHL UI is reported stale.
    const scope = new URL(getInstallUrl('s')).searchParams.get('scope') ?? '';
    expect(scope.split(' ')).toContain('calendars/events.readonly');
  });

  it('throws when OAuth env vars are missing', () => {
    delete process.env.GHL_CLIENT_ID;
    expect(() => getInstallUrl('s')).toThrow(/Missing GHL OAuth env/);
  });
});

describe('exchangeCode', () => {
  it('posts an authorization_code grant and returns the token payload', async () => {
    const f = stubFetch();
    f.mockResolvedValue(ok(tokenResponse));
    const res = await exchangeCode('auth-code');
    expect(res).toEqual(tokenResponse);
    const body = formBody(f);
    expect(body.grant_type).toBe('authorization_code');
    expect(body.code).toBe('auth-code');
    expect(body.client_secret).toBe('secret');
  });

  it('throws on a non-ok response', async () => {
    stubFetch().mockResolvedValue(err(400, 'bad code'));
    await expect(exchangeCode('x')).rejects.toThrow(/token exchange failed \(400\)/);
  });
});

describe('refreshAccessToken', () => {
  it('posts a refresh_token grant and returns the token payload', async () => {
    const f = stubFetch();
    f.mockResolvedValue(ok(tokenResponse));
    const res = await refreshAccessToken('old-refresh');
    expect(res).toEqual(tokenResponse);
    const body = formBody(f);
    expect(body.grant_type).toBe('refresh_token');
    expect(body.refresh_token).toBe('old-refresh');
  });

  it('throws on a non-ok response', async () => {
    stubFetch().mockResolvedValue(err(401, 'expired'));
    await expect(refreshAccessToken('x')).rejects.toThrow(/token refresh failed \(401\)/);
  });
});
