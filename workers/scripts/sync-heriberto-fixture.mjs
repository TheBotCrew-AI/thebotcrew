/**
 * Regenerate the Heriberto eval fixture from PROD — HERIBERTO_PERSONA, _SERVICES, _HOURS, _FAQ
 * in src/roles/front-desk/evals/fixtures.ts — so the golden cases keep testing the text that
 * actually serves the tenant. Run after every edit to that tenant row (CLAUDE.md: "the eval
 * fixtures MIRROR prod"). Needs SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in workers/.env.
 *
 *   node scripts/sync-heriberto-fixture.mjs        # then: git diff, pnpm typecheck, pnpm eval
 */
import { createClient } from '@supabase/supabase-js';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
for (const line of readFileSync(`${ROOT}.env`, 'utf8').split('\n')) {
  const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, '');
}
const LOCATION = 'rfL7uM3c5mpfIUGxCR3C';
const FILE = `${ROOT}src/roles/front-desk/evals/fixtures.ts`;

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const { data, error } = await sb
  .from('tenant_config')
  .select('prompt_overrides, services, hours, faq, tenants!inner(ghl_location_id)')
  .eq('tenants.ghl_location_id', LOCATION)
  .single();
if (error) throw error;

const tpl = (s) => '`' + String(s).replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${') + '`';
const po = data.prompt_overrides;
const TOOL_ORDER = ['getAvailability', 'bookAppointment', 'flagPendingInfo', 'updateConversationStatus'];
const persona = [
  'export const HERIBERTO_PERSONA = {',
  ...['identity', 'offering', 'qualificationNotes', 'houseRules'].map((k) => `  ${k}:\n    ${tpl(po[k])},`),
  '  toolInstructions: {',
  ...TOOL_ORDER.map((k) => `    ${k}:\n      ${tpl(po.toolInstructions[k])},`),
  '  },',
  `  bookingEnabled: ${po.bookingEnabled},`,
  `  confirmContactName: ${po.confirmContactName},`,
  '};',
].join('\n');
const extraTools = Object.keys(po.toolInstructions).filter((k) => !TOOL_ORDER.includes(k));
const extraKeys = Object.keys(po).filter((k) => !['identity', 'offering', 'qualificationNotes', 'houseRules', 'toolInstructions', 'bookingEnabled', 'confirmContactName'].includes(k));
if (extraTools.length || extraKeys.length) throw new Error(`prompt_overrides has keys this generator doesn't know: ${[...extraKeys, ...extraTools].join(', ')}`);

let src = readFileSync(FILE, 'utf8');
const swap = (name, body) => {
  const re = new RegExp(`export const ${name} = [\\s\\S]*?\\n(\\};|\\];)\\n`);
  if (!re.test(src)) throw new Error(`${name} block not found`);
  // Replacer function: a plain string would expand `$1` inside prices like "$12,500".
  src = src.replace(re, () => body + '\n');
};
swap('HERIBERTO_PERSONA', persona);
swap('HERIBERTO_SERVICES', `export const HERIBERTO_SERVICES = ${JSON.stringify(data.services, null, 2)};`);
// jsonb reorders keys (by length, then alphabetically); keep the week in order for a readable diff.
const hours = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].filter((d) => d in data.hours).map((d) => [d, data.hours[d]]));
swap('HERIBERTO_HOURS', `export const HERIBERTO_HOURS = ${JSON.stringify(hours, null, 2)};`);
const faq = data.faq.map(({ q, a }) => ({ q, a })); // jsonb stores `a` before `q`; keep q first
swap('HERIBERTO_FAQ', `export const HERIBERTO_FAQ = ${JSON.stringify(faq, null, 2)};`);
writeFileSync(FILE, src);
console.log('fixtures.ts regenerated from prod — review with git diff');
