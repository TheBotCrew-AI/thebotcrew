import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { createClient } = vi.hoisted(() => ({ createClient: vi.fn(() => ({ sentinel: true })) }));
vi.mock('@supabase/supabase-js', () => ({ createClient }));

import { getSupabase } from './client.js';

beforeEach(() => {
  vi.clearAllMocks();
  process.env.SUPABASE_URL = 'https://db';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key';
});

afterEach(() => {
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
});

describe('getSupabase', () => {
  it('creates a service-role client (RLS-bypassing, no session) and memoizes it', () => {
    const a = getSupabase();
    const b = getSupabase();
    expect(a).toBe(b); // cached
    expect(createClient).toHaveBeenCalledTimes(1);
    expect(createClient).toHaveBeenCalledWith('https://db', 'service-key', {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  });
});
