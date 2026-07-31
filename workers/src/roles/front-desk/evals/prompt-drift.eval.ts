/**
 * Prompt drift check — does the eval fixture still match what's LIVE?
 *
 * The agent's real behavior is DB text (`tenant_config.prompt_overrides`), which
 * evals cannot read at test time, so `fixtures.ts` carries a hand-typed copy of
 * the rules under test. That copy can rot: edit the tenant row in Supabase and
 * every golden case keeps passing against text nobody is running anymore — green
 * tests that prove nothing. This case is the alarm for exactly that.
 *
 * It is the ONLY case in the suite that talks to the database, and it lives in an
 * `.eval.ts` file so the CI gate (`test:unit`, which excludes `*.eval.ts`) never
 * depends on network or credentials. It self-skips when Supabase env vars are
 * absent, the same way live cases skip without an API key.
 *
 * When it fails: read prod, decide which side is right, and update the other.
 * Usually prod is right (Leo edits the tenant) and the fixture must be re-copied.
 */

import { describe, it, expect } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { FIT_FILTER_SECTION } from './fixtures.js';

/** The Bot Crew's own tenant — the only one whose prompt these evals mirror. */
const BOT_CREW_TENANT_ID = '04385692-5c0d-436e-af77-4b1aa3fcc223';

const supabaseUrl = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

/**
 * First line where the two texts diverge, so a failure points at the edit instead
 * of dumping two walls of Spanish and leaving you to diff them by eye.
 */
function firstDifference(live: string, fixture: string): string {
  const a = live.split('\n');
  const b = fixture.split('\n');
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) {
      return `line ${i + 1}\n  live:    ${JSON.stringify(a[i] ?? '<missing>')}\n  fixture: ${JSON.stringify(b[i] ?? '<missing>')}`;
    }
  }
  return 'no line differs (trailing whitespace?)';
}

describe.skipIf(!supabaseUrl || !serviceKey)('prompt drift — live tenant vs eval fixture', () => {
  it('The Bot Crew houseRules still match FIT_FILTER_SECTION', async () => {
    const supabase = createClient(supabaseUrl!, serviceKey!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await supabase
      .from('tenant_config')
      .select('prompt_overrides')
      .eq('tenant_id', BOT_CREW_TENANT_ID)
      .single();

    expect(error, `tenant_config read failed: ${error?.message}`).toBeNull();

    const overrides = data?.prompt_overrides as { houseRules?: string } | null;
    const live = overrides?.houseRules?.trim() ?? '';

    // An empty houseRules is the loudest possible drift: the fit filter is simply
    // not in the prompt any more, and every golden case below would still pass.
    expect(live, 'prod has NO houseRules — the fit filter is not live').not.toBe('');

    const fixture = FIT_FILTER_SECTION.trim();
    expect(live, `prod and fixture diverge at ${firstDifference(live, fixture)}\n\n`).toBe(fixture);
  });
});
