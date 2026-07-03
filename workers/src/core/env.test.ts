import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getCoreEnv, getAiApiKey, getGhlEnv, getGhlOAuthEnv } from './env.js';

const KEYS = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GHL_API_BASE', 'GHL_API_TOKEN', 'GHL_WEBHOOK_SECRET', 'GHL_CLIENT_ID', 'GHL_CLIENT_SECRET', 'GHL_OAUTH_REDIRECT_URI'];
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
