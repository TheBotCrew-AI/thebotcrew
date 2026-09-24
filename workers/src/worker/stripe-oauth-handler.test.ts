import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleStripeOAuthCallback } from './stripe-oauth-handler.js';

const CODE = 'ac_VJhY4iM9q5GGG7k2D4QZ7UhjhBPgsKtx';
const fetchMock = vi.fn();
const saved = { ...process.env };

function ok(body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), { status: 200 });
}
function refused(status: number, error: string) {
  return new Response(JSON.stringify({ error, error_description: `desc ${error}` }), { status });
}
function bodyOf(call: unknown[]): URLSearchParams {
  return new URLSearchParams(String((call[1] as RequestInit).body));
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  delete process.env.STRIPE_MODE;
  process.env.STRIPE_SECRET_KEY = 'sk_live_x';
  process.env.STRIPE_SECRET_KEY_TEST_MODE = 'sk_test_x';
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  process.env = { ...saved };
});

describe('GET /stripe/oauth/callback', () => {
  it('exchanges the code with the current mode key and shows the connected account', async () => {
    fetchMock.mockResolvedValue(
      ok({ stripe_user_id: 'acct_1ABC', livemode: true, scope: 'read_write', access_token: 'sk_live_SECRET', refresh_token: 'rt_SECRET' }),
    );
    const out = await handleStripeOAuthCallback({ code: CODE });

    expect(out.status).toBe(200);
    expect(out.account).toBe('acct_1ABC');
    expect(out.html).toContain('acct_1ABC');
    expect(out.html).not.toContain('modo de prueba');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe('https://connect.stripe.com/oauth/token');
    const body = bodyOf(fetchMock.mock.calls[0]!);
    expect(body.get('client_secret')).toBe('sk_live_x');
    expect(body.get('code')).toBe(CODE);
    expect(body.get('grant_type')).toBe('authorization_code');
  });

  it('never puts the returned tokens on the page or in the logs', async () => {
    fetchMock.mockResolvedValue(ok({ stripe_user_id: 'acct_1ABC', livemode: true, access_token: 'sk_live_SECRET', refresh_token: 'rt_SECRET' }));
    const out = await handleStripeOAuthCallback({ code: CODE });
    const logged = JSON.stringify(vi.mocked(console.log).mock.calls);
    for (const secret of ['sk_live_SECRET', 'rt_SECRET', 'sk_live_x']) {
      expect(out.html).not.toContain(secret);
      expect(logged).not.toContain(secret);
    }
    expect(logged).toContain('acct_1ABC');
  });

  it('a 4xx with the live key falls through to the test key (a test-mode authorization)', async () => {
    fetchMock.mockResolvedValueOnce(refused(400, 'invalid_grant')).mockResolvedValueOnce(ok({ stripe_user_id: 'acct_T', livemode: false }));
    const out = await handleStripeOAuthCallback({ code: CODE });

    expect(out.status).toBe(200);
    expect(out.html).toContain('modo de prueba');
    expect(bodyOf(fetchMock.mock.calls[1]!).get('client_secret')).toBe('sk_test_x');
  });

  it('STRIPE_MODE=test tries the test key first', async () => {
    process.env.STRIPE_MODE = 'test';
    fetchMock.mockResolvedValue(ok({ stripe_user_id: 'acct_T', livemode: false }));
    await handleStripeOAuthCallback({ code: CODE });
    expect(bodyOf(fetchMock.mock.calls[0]!).get('client_secret')).toBe('sk_test_x');
  });

  it('a 5xx stops — no second attempt with the other key', async () => {
    fetchMock.mockResolvedValue(new Response('oops', { status: 503 }));
    const out = await handleStripeOAuthCallback({ code: CODE });
    expect(out.status).toBe(502);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('both keys refused → 502, the error is logged, the page reveals nothing', async () => {
    fetchMock.mockResolvedValue(refused(400, 'invalid_grant'));
    const out = await handleStripeOAuthCallback({ code: CODE });
    expect(out.status).toBe(502);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(out.html).not.toContain('invalid_grant');
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).toContain('invalid_grant');
  });

  it('the client cancelled on Stripe (error=access_denied) → 400, Stripe is not called', async () => {
    const out = await handleStripeOAuthCallback({ error: 'access_denied', error_description: 'The user denied your request' });
    expect(out.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a missing or malformed code → 400, Stripe is not called', async () => {
    for (const code of [undefined, '', 'nope', 'ac_<script>']) {
      const out = await handleStripeOAuthCallback({ code });
      expect(out.status).toBe(400);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('no secret key configured → 503, loud in the logs', async () => {
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_SECRET_KEY_TEST_MODE;
    const out = await handleStripeOAuthCallback({ code: CODE });
    expect(out.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalled();
  });

  it('only the live key set → a single attempt', async () => {
    delete process.env.STRIPE_SECRET_KEY_TEST_MODE;
    fetchMock.mockResolvedValue(refused(400, 'invalid_grant'));
    await handleStripeOAuthCallback({ code: CODE });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('the account id is HTML-escaped on the page', async () => {
    fetchMock.mockResolvedValue(ok({ stripe_user_id: 'acct_<b>x</b>', livemode: true }));
    const out = await handleStripeOAuthCallback({ code: CODE });
    expect(out.html).toContain('acct_&lt;b&gt;x&lt;/b&gt;');
  });
});
