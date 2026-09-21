/**
 * Regenerate The Bot Crew eval fixture from PROD — BOT_CREW_PERSONA and BOT_CREW_FAQ in
 * src/roles/front-desk/evals/fixtures.ts — so the golden cases keep testing the text that
 * actually serves the tenant. Run after every edit to that tenant row (CLAUDE.md: "the eval
 * fixtures MIRROR prod"). Twin of sync-heriberto-fixture.mjs; needs SUPABASE_URL /
 * SUPABASE_SERVICE_ROLE_KEY in workers/.env.
 *
 *   node scripts/sync-botcrew-fixture.mjs        # then: git diff, pnpm typecheck, pnpm eval
 */
import { createClient } from '@supabase/supabase-js';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
for (const line of readFileSync(`${ROOT}.env`, 'utf8').split('\n')) {
  const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, '');
}
const TENANT = '04385692-5c0d-436e-af77-4b1aa3fcc223';
const FILE = `${ROOT}src/roles/front-desk/evals/fixtures.ts`;

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const { data, error } = await sb
  .from('tenant_config')
  .select('prompt_overrides, faq')
  .eq('tenant_id', TENANT)
  .single();
if (error) throw error;

const tpl = (s) => '`' + String(s).replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${') + '`';
const po = data.prompt_overrides;
const TOOL_ORDER = ['getAvailability', 'bookAppointment'];
const KEY_ORDER = ['identity', 'offering', 'qualificationNotes', 'houseRules'];
const persona = [
  'export const BOT_CREW_PERSONA = {',
  ...KEY_ORDER.map((k) => `  ${k}:\n    ${tpl(po[k])},`),
  '  toolInstructions: {',
  ...TOOL_ORDER.map((k) => `    ${k}:\n      ${tpl(po.toolInstructions[k])},`),
  '  },',
  `  confirmContactName: ${po.confirmContactName},`,
  `  bookingEnabled: ${po.bookingEnabled},`,
  '};',
].join('\n');
const extraTools = Object.keys(po.toolInstructions).filter((k) => !TOOL_ORDER.includes(k));
const extraKeys = Object.keys(po).filter(
  (k) => ![...KEY_ORDER, 'toolInstructions', 'bookingEnabled', 'confirmContactName'].includes(k),
);
if (extraTools.length || extraKeys.length)
  throw new Error(`prompt_overrides has keys this generator doesn't know: ${[...extraKeys, ...extraTools].join(', ')}`);

let src = readFileSync(FILE, 'utf8');
const swap = (name, body) => {
  const re = new RegExp(`export const ${name} = [\\s\\S]*?\\n(\\};|\\];)\\n`);
  if (!re.test(src)) throw new Error(`${name} block not found`);
  // Replacer function: a plain string would expand `$1` inside prices like "$500".
  src = src.replace(re, () => body + '\n');
};
swap('BOT_CREW_PERSONA', persona);
// jsonb stores `a` before `q`; keep q first so the diff shows only real changes.
const faq = data.faq.map(({ q, a }) => ({ q, a }));
swap('BOT_CREW_FAQ', `export const BOT_CREW_FAQ = ${JSON.stringify(faq, null, 2)};`);
writeFileSync(FILE, src);
console.log('fixtures.ts regenerated from prod — review with git diff');
