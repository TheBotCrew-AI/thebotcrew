/**
 * Regenerate the HappyNatyNat eval fixture from PROD — HAPPYNATY_PERSONA, _SERVICES, _HOURS, _FAQ,
 * _VARIANTS and _KEYWORD_VARIANTS in src/roles/front-desk/evals/fixtures.ts — so the golden cases
 * keep testing the text that actually serves the tenant. Run after every edit to that tenant row
 * (CLAUDE.md: "the eval fixtures MIRROR prod"). Needs SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in
 * workers/.env.
 *
 *   node scripts/sync-happynaty-fixture.mjs                  # from prod
 *   node scripts/sync-happynaty-fixture.mjs --from cfg.json  # from a row not applied yet
 */
import { createClient } from '@supabase/supabase-js';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const LOCATION = 'X8zdJcQaVckHuF3W4grr';
const FILE = `${ROOT}src/roles/front-desk/evals/fixtures.ts`;
const COLUMNS = ['prompt_overrides', 'services', 'hours', 'faq', 'prompt_variants', 'keyword_variants'];

const fromIdx = process.argv.indexOf('--from');
let data;
if (fromIdx > 0) {
  data = JSON.parse(readFileSync(process.argv[fromIdx + 1], 'utf8'));
} else {
  for (const line of readFileSync(`${ROOT}.env`, 'utf8').split('\n')) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, '');
  }
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const res = await sb
    .from('tenant_config')
    .select(`${COLUMNS.join(', ')}, tenants!inner(ghl_location_id)`)
    .eq('tenants.ghl_location_id', LOCATION)
    .single();
  if (res.error) throw res.error;
  data = res.data;
}

const tpl = (s) => '`' + String(s).replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${') + '`';
const PERSONA_KEYS = ['identity', 'offering', 'qualificationNotes', 'houseRules'];
const TOOL_ORDER = ['getAvailability', 'bookAppointment', 'flagPendingInfo', 'updateConversationStatus'];
const VARIANT_ORDER = ['p2b', 'p4', 'p8', 'c1', 'c2', 'c3'];

const po = data.prompt_overrides;
const extraTools = Object.keys(po.toolInstructions).filter((k) => !TOOL_ORDER.includes(k));
const extraKeys = Object.keys(po).filter((k) => ![...PERSONA_KEYS, 'toolInstructions', 'bookingEnabled', 'confirmContactName'].includes(k));
if (extraTools.length || extraKeys.length) throw new Error(`prompt_overrides has keys this generator doesn't know: ${[...extraKeys, ...extraTools].join(', ')}`);
const pv = data.prompt_variants;
const extraVariants = Object.keys(pv).filter((k) => !VARIANT_ORDER.includes(k));
const extraVariantKeys = Object.values(pv).flatMap((v) => Object.keys(v)).filter((k) => !['qualificationNotes', 'calendarLabel'].includes(k));
if (extraVariants.length || extraVariantKeys.length) throw new Error(`prompt_variants has entries this generator doesn't know: ${[...extraVariants, ...extraVariantKeys].join(', ')}`);

const persona = [
  'export const HAPPYNATY_PERSONA = {',
  ...PERSONA_KEYS.map((k) => `  ${k}:\n    ${tpl(po[k])},`),
  '  toolInstructions: {',
  ...TOOL_ORDER.map((k) => `    ${k}:\n      ${tpl(po.toolInstructions[k])},`),
  '  },',
  `  bookingEnabled: ${po.bookingEnabled},`,
  `  confirmContactName: ${po.confirmContactName},`,
  '};',
].join('\n');
const variants = [
  'export const HAPPYNATY_VARIANTS = {',
  ...VARIANT_ORDER.filter((k) => k in pv).flatMap((k) => [
    `  ${k}: {`,
    `    qualificationNotes:\n      ${tpl(pv[k].qualificationNotes)},`,
    `    calendarLabel: ${JSON.stringify(pv[k].calendarLabel)},`,
    '  },',
  ]),
  '};',
].join('\n');

let src = readFileSync(FILE, 'utf8');
const swap = (name, body) => {
  const re = new RegExp(`export const ${name}(: [^=]+)? = [\\s\\S]*?\\n(\\};|\\];)\\n`);
  if (!re.test(src)) throw new Error(`${name} block not found`);
  // Replacer function: a plain string would expand `$1` inside prices like "$4,850".
  src = src.replace(re, () => body + '\n');
};
swap('HAPPYNATY_PERSONA', persona);
swap('HAPPYNATY_SERVICES', `export const HAPPYNATY_SERVICES = ${JSON.stringify(data.services, null, 2)};`);
const hours = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].filter((d) => d in data.hours).map((d) => [d, data.hours[d]]));
swap('HAPPYNATY_HOURS', `export const HAPPYNATY_HOURS = ${JSON.stringify(hours, null, 2)};`);
const faq = data.faq.map(({ q, a }) => ({ q, a })); // jsonb stores `a` before `q`; keep q first
swap('HAPPYNATY_FAQ', `export const HAPPYNATY_FAQ = ${JSON.stringify(faq, null, 2)};`);
swap('HAPPYNATY_VARIANTS', variants);
// jsonb reorders keys by length; sort by variant so each ad's phrases sit together.
const kv = Object.fromEntries(
  Object.entries(data.keyword_variants).sort(([ka, va], [kb, vb]) => VARIANT_ORDER.indexOf(va) - VARIANT_ORDER.indexOf(vb) || kb.length - ka.length),
);
swap('HAPPYNATY_KEYWORD_VARIANTS', `export const HAPPYNATY_KEYWORD_VARIANTS: Record<string, string> = ${JSON.stringify(kv, null, 2)};`);
writeFileSync(FILE, src);
console.log(`fixtures.ts regenerated from ${fromIdx > 0 ? process.argv[fromIdx + 1] : 'prod'} — review with git diff`);
