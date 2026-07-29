/**
 * Typed environment access.
 *
 * Read lazily at request time (not module load): on Cloudflare Workers the
 * Mastra Cloudflare deployer injects Worker secrets/vars into `process.env`,
 * and `mastra dev` loads `workers/.env` into `process.env`. Either way, by the
 * time a webhook handler runs the vars are present.
 *
 * NEVER hardcode secrets. See `.dev.vars.example`.
 */

export interface CoreEnv {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
}

export interface GhlEnv {
  /** Base URL for the GHL API. */
  apiBase: string;
  /** Shared secret / signing key used to verify inbound webhooks. */
  webhookSecret: string | undefined;
  /** Fallback/agency API token used when a tenant has no OAuth token yet. */
  apiToken: string | undefined;
}

export interface GhlOAuthEnv {
  /** OAuth2 client id from the GHL App Marketplace. */
  clientId: string;
  /** OAuth2 client secret from the GHL App Marketplace. */
  clientSecret: string;
  /** Full callback URL registered in the GHL app (e.g. https://…/oauth/ghl/callback). */
  redirectUri: string;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function getCoreEnv(): CoreEnv {
  return {
    SUPABASE_URL: required('SUPABASE_URL'),
    SUPABASE_SERVICE_ROLE_KEY: required('SUPABASE_SERVICE_ROLE_KEY'),
  };
}

/** The Worker secret holding the platform-wide key for a provider. */
function platformKeyName(provider: import('./types.js').AiProvider): string {
  return provider === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY';
}

/**
 * Worker-secret name for a tenant's own key: `OPENAI_API_KEY__MADI`.
 *
 * The DB stores only this slug (`tenant_config.ai_key_ref`), never key material —
 * the key itself stays in Cloudflare's secret store. Env var names can't hold
 * arbitrary text, so the slug is normalized: uppercased, runs of non-alphanumerics
 * collapsed to `_`, edges trimmed. Returns null when nothing usable is left, so a
 * junk ref degrades to the platform key instead of probing a nonsense var.
 */
export function aiKeySecretName(
  provider: import('./types.js').AiProvider,
  keyRef: string,
): string | null {
  const slug = keyRef
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!slug) return null;
  return `${platformKeyName(provider)}__${slug}`;
}

/** Where a resolved key came from — recorded on every usage row for attribution. */
export interface AiKeyResolution {
  apiKey: string;
  /** `'platform'` or the tenant's ai_key_ref slug. */
  source: string;
  /** True when a tenant ref was set but its secret was missing → platform key used. */
  fellBack: boolean;
}

/**
 * Resolve the API key for a turn: the tenant's own key when `ai_key_ref` points at
 * an existing Worker secret, otherwise the platform key.
 *
 * Deliberately FALLS BACK rather than throwing when a tenant's secret is absent:
 * this whole runtime is built around never dropping a turn, and a tenant going
 * silent over a misconfigured secret is worse than one month of spend landing on
 * the platform key. `fellBack` is surfaced so the caller can log it — the fallback
 * is loud in bot_events, never silent.
 *
 * Throws only when there is no usable key at all.
 */
export function resolveAiApiKey(
  provider: import('./types.js').AiProvider,
  keyRef?: string | null,
): AiKeyResolution {
  if (keyRef?.trim()) {
    const secretName = aiKeySecretName(provider, keyRef);
    const tenantKey = secretName ? process.env[secretName] : undefined;
    if (tenantKey) {
      return { apiKey: tenantKey, source: keyRef.trim(), fellBack: false };
    }
    const platformKey = process.env[platformKeyName(provider)];
    if (!platformKey) {
      throw new Error(
        `Missing AI key: neither ${secretName ?? '(invalid ai_key_ref)'} nor ${platformKeyName(provider)} is set`,
      );
    }
    return { apiKey: platformKey, source: 'platform', fellBack: true };
  }

  return { apiKey: required(platformKeyName(provider)), source: 'platform', fellBack: false };
}

/**
 * Return the API key for the given AI provider, read from Worker secrets.
 * Throws if the key for that provider is not set.
 *
 * Platform-key-only shorthand; prefer `resolveAiApiKey` on any path that knows
 * its tenant, so spend is attributed to that tenant's key.
 */
export function getAiApiKey(provider: import('./types.js').AiProvider): string {
  return required(platformKeyName(provider));
}

export function getGhlEnv(): GhlEnv {
  return {
    apiBase: process.env.GHL_API_BASE ?? 'https://services.leadconnectorhq.com',
    webhookSecret: process.env.GHL_WEBHOOK_SECRET,
    apiToken: process.env.GHL_API_TOKEN,
  };
}

export function getGhlOAuthEnv(): GhlOAuthEnv {
  const clientId = process.env.GHL_CLIENT_ID;
  const clientSecret = process.env.GHL_CLIENT_SECRET;
  const redirectUri = process.env.GHL_OAUTH_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error('Missing GHL OAuth env vars: GHL_CLIENT_ID, GHL_CLIENT_SECRET, GHL_OAUTH_REDIRECT_URI');
  }
  return { clientId, clientSecret, redirectUri };
}
