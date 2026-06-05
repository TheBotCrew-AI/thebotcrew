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
  /** Fallback/agency API token. Per-tenant tokens (TBD) resolve via tenants.ghl_token_ref. */
  apiToken: string | undefined;
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
