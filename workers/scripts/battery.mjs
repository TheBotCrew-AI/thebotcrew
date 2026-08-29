/**
 * Run a tenant's showcase battery (see src/battery/battery.eval.ts).
 *
 *   pnpm battery heriberto
 *   pnpm battery heriberto --only lead-bueno-botox,solo-info-precios
 *   pnpm battery heriberto --lead-model gpt-5-mini     # cheaper lead, same bot
 *
 * Then: pnpm battery:render heriberto
 */
import { spawnSync } from 'node:child_process';

const argv = process.argv.slice(2);
const slug = argv.find((a) => !a.startsWith('--'));
if (!slug) {
  console.error('uso: pnpm battery <tenant-slug> [--only id,id] [--lead-model <model>]');
  process.exit(2);
}
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

const env = { ...process.env, BATTERY_TENANT: slug };
if (flag('only')) env.BATTERY_ONLY = flag('only');
if (flag('lead-model')) env.BATTERY_LEAD_MODEL = flag('lead-model');

const res = spawnSync(
  'pnpm',
  ['exec', 'vitest', 'run', 'src/battery/battery.eval.ts', '--fileParallelism=false', '--reporter=basic', '--silent=false'],
  { stdio: 'inherit', env },
);
process.exit(res.status ?? 1);
