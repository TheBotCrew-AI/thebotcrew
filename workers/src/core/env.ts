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
  ANTHROPIC_API_KEY: string;
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

function required(name: keyof CoreEnv): string {
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
    ANTHROPIC_API_KEY: required('ANTHROPIC_API_KEY'),
  };
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
