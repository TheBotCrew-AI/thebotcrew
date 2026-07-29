import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getCoreEnv, getAiApiKey, aiKeySecretName, resolveAiApiKey, getGhlEnv, getGhlOAuthEnv } from './env.js';

const KEYS = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GHL_API_BASE', 'GHL_API_TOKEN', 'GHL_WEBHOOK_SECRET', 'GHL_CLIENT_ID', 'GHL_CLIENT_SECRET', 'GHL_OAUTH_REDIRECT_URI', 'OPENAI_API_KEY__MADI', 'ANTHROPIC_API_KEY__MADI'];
beforeEach(() => KEYS.forEach((k) => delete process.env[k]));
afterEach(() => KEYS.forEach((k) => delete process.env[k]));

describe('getAiApiKey', () => {
  it('selects the provider-specific key', () => {
    process.env.OPENAI_API_KEY = 'oai';
    process.env.ANTHROPIC_API_KEY = 'ant';
    expect(getAiApiKey('openai')).toBe('oai');
    expect(getAiApiKey('anthropic')).toBe('ant');
  });

  it('throws when the key for the provider is missing', () => {
    expect(() => getAiApiKey('openai')).toThrow(/OPENAI_API_KEY/);
  });
});

describe('aiKeySecretName', () => {
  it('builds a per-provider, per-tenant secret name', () => {
    expect(aiKeySecretName('openai', 'MADI')).toBe('OPENAI_API_KEY__MADI');
    expect(aiKeySecretName('anthropic', 'MADI')).toBe('ANTHROPIC_API_KEY__MADI');
  });

  it('normalizes refs that are not valid env-var fragments', () => {
    // Env var names can't hold spaces, dashes, accents or casing variance.
    expect(aiKeySecretName('openai', ' madi skin-care ')).toBe('OPENAI_API_KEY__MADI_SKIN_CARE');
    expect(aiKeySecretName('openai', 'happy.Naty--Nat')).toBe('OPENAI_API_KEY__HAPPY_NATY_NAT');
  });

  it('returns null when nothing usable survives normalization', () => {
    // Guards against probing a nonsense var like `OPENAI_API_KEY__`.
    expect(aiKeySecretName('openai', '---')).toBeNull();
    expect(aiKeySecretName('openai', '   ')).toBeNull();
  });
});

describe('resolveAiApiKey', () => {
  it('uses the platform key when the tenant has no ref', () => {
    process.env.OPENAI_API_KEY = 'platform';
    expect(resolveAiApiKey('openai', null)).toEqual({ apiKey: 'platform', source: 'platform', fellBack: false });
    expect(resolveAiApiKey('openai', undefined)).toEqual({ apiKey: 'platform', source: 'platform', fellBack: false });
    // Whitespace-only ref is not a ref.
    expect(resolveAiApiKey('openai', '  ')).toEqual({ apiKey: 'platform', source: 'platform', fellBack: false });
  });

  it("uses the tenant's own key when its secret exists, and reports the source", () => {
    process.env.OPENAI_API_KEY = 'platform';
    process.env.OPENAI_API_KEY__MADI = 'madi-key';
    expect(resolveAiApiKey('openai', 'MADI')).toEqual({ apiKey: 'madi-key', source: 'MADI', fellBack: false });
  });

  it('picks the secret matching the provider, not just the ref', () => {
    process.env.ANTHROPIC_API_KEY = 'platform-ant';
    process.env.OPENAI_API_KEY__MADI = 'madi-openai';
    process.env.ANTHROPIC_API_KEY__MADI = 'madi-ant';
    expect(resolveAiApiKey('anthropic', 'MADI').apiKey).toBe('madi-ant');
  });

  it('falls back to the platform key (flagged) when the tenant secret is missing', () => {
    // The deliberate choice: a misconfigured ref must not silence the tenant.
    process.env.OPENAI_API_KEY = 'platform';
    expect(resolveAiApiKey('openai', 'MADI')).toEqual({ apiKey: 'platform', source: 'platform', fellBack: true });
  });

  it('throws only when neither the tenant nor the platform key exists', () => {
    expect(() => resolveAiApiKey('openai', 'MADI')).toThrow(/OPENAI_API_KEY__MADI.*OPENAI_API_KEY/s);
  });
});

describe('getCoreEnv', () => {
  it('reads Supabase creds, throws if absent', () => {
    expect(() => getCoreEnv()).toThrow(/SUPABASE_URL/);
    process.env.SUPABASE_URL = 'u';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'k';
    expect(getCoreEnv()).toEqual({ SUPABASE_URL: 'u', SUPABASE_SERVICE_ROLE_KEY: 'k' });
  });
});

describe('getGhlEnv', () => {
  it('defaults the API base when unset', () => {
    expect(getGhlEnv().apiBase).toBe('https://services.leadconnectorhq.com');
  });

  it('reads overrides from env', () => {
    process.env.GHL_API_BASE = 'https://api.ghl';
    process.env.GHL_API_TOKEN = 'tok';
    expect(getGhlEnv()).toMatchObject({ apiBase: 'https://api.ghl', apiToken: 'tok' });
  });
});

describe('getGhlOAuthEnv', () => {
  it('throws when any OAuth var is missing', () => {
    process.env.GHL_CLIENT_ID = 'cid';
    expect(() => getGhlOAuthEnv()).toThrow(/Missing GHL OAuth/);
  });

  it('returns all three when present', () => {
    process.env.GHL_CLIENT_ID = 'cid';
    process.env.GHL_CLIENT_SECRET = 'sec';
    process.env.GHL_OAUTH_REDIRECT_URI = 'https://cb';
    expect(getGhlOAuthEnv()).toEqual({ clientId: 'cid', clientSecret: 'sec', redirectUri: 'https://cb' });
  });
});
