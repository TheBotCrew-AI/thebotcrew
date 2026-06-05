/**
 * Supabase client (service-role).
 *
 * The Worker talks to Supabase over HTTP with the service-role key, which
 * BYPASSES RLS — this is server-side only and must never reach a browser.
 * History/config reads and RPC writes all go through this client, so we never
 * depend on GHL for conversation history.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { getCoreEnv } from '../core/env.js';

let cached: SupabaseClient | undefined;

export function getSupabase(): SupabaseClient {
  if (!cached) {
    const env = getCoreEnv();
    cached = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return cached;
}
