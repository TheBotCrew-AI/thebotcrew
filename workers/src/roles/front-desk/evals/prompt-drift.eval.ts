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
 *
 * CONTAINMENT, not equality (changed 2026-08-01). `houseRules` used to hold one
 * section and equality was the strictest possible check. It now holds everything
 * that must survive a campaign variant — the fit filter, the conversation
 * principles, the opening protocol, the absolute rules — because a variant
 * replaces `qualificationNotes` wholesale and anything left there would vanish
 * with it. Mirroring all of that byte-for-byte would mean every wording tweak
 * anywhere in it breaks an unrelated eval, and a check that cries wolf gets
 * ignored. So each fixture mirrors the SECTION its golden cases exercise, and we
 * assert prod still contains it verbatim: still catches the rule being edited,
 * reworded or deleted, which is the whole point.
 */

import { describe, it, expect } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { CALL_OFFER_RULE, DEMO_BOTOX_PERSONA, FIT_FILTER_SECTION, MADI_HOUSE_RULES, MONEY_DISCLOSURE_RULES } from './fixtures.js';

/**
 * Tenants whose `houseRules` an eval fixture mirrors, and must keep mirroring.
 * A tenant may appear more than once: each entry is one contiguous section, so
 * mirroring two rules that live apart in the row does not force the fixture to
 * copy everything between them.
 */
const MIRRORED_HOUSE_RULES: { label: string; tenantId: string; fixture: string }[] = [
  { label: 'The Bot Crew — fit filter', tenantId: '04385692-5c0d-436e-af77-4b1aa3fcc223', fixture: FIT_FILTER_SECTION },
  { label: 'The Bot Crew — money rules', tenantId: '04385692-5c0d-436e-af77-4b1aa3fcc223', fixture: MONEY_DISCLOSURE_RULES },
  { label: 'The Bot Crew — call offer', tenantId: '04385692-5c0d-436e-af77-4b1aa3fcc223', fixture: CALL_OFFER_RULE },
  { label: 'MADI Skin Care', tenantId: '19cf934b-2e36-4f4b-aa77-d3287e8d38fb', fixture: MADI_HOUSE_RULES },
];

/**
 * The Bot Crew's demo persona lives in a different column (`demo_prompt_overrides`)
 * and is mirrored WHOLE, not by section — see DEMO_BOTOX_PERSONA. So it gets its own
 * check, field by field: a whole-object compare would report "the persona changed"
 * and leave you to find where.
 */
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
  it.each(MIRRORED_HOUSE_RULES)('$label houseRules still match the fixture', async ({ tenantId, fixture }) => {
    const supabase = createClient(supabaseUrl!, serviceKey!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await supabase
      .from('tenant_config')
      .select('prompt_overrides')
      .eq('tenant_id', tenantId)
      .single();

    expect(error, `tenant_config read failed: ${error?.message}`).toBeNull();

    const overrides = data?.prompt_overrides as { houseRules?: string } | null;
    const live = overrides?.houseRules?.trim() ?? '';

    // Empty houseRules is the loudest possible drift: the rule is simply not in the
    // prompt any more, and every golden case below would still pass without it.
    expect(live, 'prod has NO houseRules — the rule under test is not live').not.toBe('');

    const expected = fixture.trim();
    // The section's first line doubles as its anchor: still there → the text was
    // edited, so point at the first differing line; gone → the whole section was
    // dropped, which is a different (worse) failure and deserves a different message.
    const anchor = expected.split('\n')[0] ?? '';
    const anchorAt = live.indexOf(anchor);
    expect(
      live.includes(expected),
      anchorAt >= 0
        ? `prod still has the section but its text changed — diverges at ${firstDifference(live.slice(anchorAt), expected)}\n\n`
        : 'the mirrored section is GONE from prod houseRules — the golden cases now test text nobody runs\n\n',
    ).toBe(true);
  });
});

describe.skipIf(!supabaseUrl || !serviceKey)('prompt drift — the botox demo persona', () => {
  it.each(Object.keys(DEMO_BOTOX_PERSONA))('demo_prompt_overrides.%s still matches the fixture', async (field) => {
    const supabase = createClient(supabaseUrl!, serviceKey!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await supabase
      .from('tenant_config')
      .select('demo_prompt_overrides')
      .eq('tenant_id', BOT_CREW_TENANT_ID)
      .single();

    expect(error, `tenant_config read failed: ${error?.message}`).toBeNull();

    const live = data?.demo_prompt_overrides as Record<string, unknown> | null;
    // No persona at all is the loudest drift: the keyword still flips the conversation
    // into demo, and the prompt falls back to the tenant's OWN identity — Sara pitching
    // the Club to someone who was promised a med spa.
    expect(live, 'prod has NO demo_prompt_overrides — the demo persona is not live').toBeTruthy();

    const expected = DEMO_BOTOX_PERSONA[field as keyof typeof DEMO_BOTOX_PERSONA];
    const actual = live?.[field];
    const show = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v, Object.keys((v as object) ?? {}).sort()));

    expect(
      show(actual) === show(expected),
      typeof expected === 'string' && typeof actual === 'string'
        ? `prod's ${field} was edited — diverges at ${firstDifference(actual, expected)}\n\n`
        : `prod's ${field} differs from the fixture\n  live:    ${show(actual)}\n  fixture: ${show(expected)}\n\n`,
    ).toBe(true);
  });
});

