/**
 * Publish a tenant's client report (battery/<slug>/render/reporte.html) to Vercel.
 *
 *   pnpm battery:publish heriberto --project sofia-demo-valdivia
 *
 * Copies ONLY reporte.html (as index.html) into a temp dir named after the project and runs
 * `vercel deploy --prod --yes` there — the Vercel CLI links a dir to the project of the same
 * name in the logged-in scope, creating it on the first run. The gallery (index.html) with the
 * tool calls never leaves the machine. Needs `vercel` on PATH and `vercel whoami` to work.
 */
import { existsSync, mkdirSync, copyFileSync, mkdtempSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const slug = argv.find((a) => !a.startsWith('--'));
const i = argv.indexOf('--project');
const project = i >= 0 ? argv[i + 1] : undefined;
if (!slug || !project) {
  console.error('uso: pnpm battery:publish <tenant-slug> --project <vercel-project>');
  process.exit(2);
}
const report = resolve(__dirname, `../battery/${slug}/render/reporte.html`);
if (!existsSync(report)) {
  console.error(`no existe ${report} — corre \`pnpm battery:render ${slug}\` primero`);
  process.exit(1);
}
const dir = resolve(mkdtempSync(resolve(tmpdir(), 'battery-publish-')), project);
mkdirSync(dir);
copyFileSync(report, resolve(dir, 'index.html'));
const res = spawnSync('vercel', ['deploy', '--prod', '--yes'], { cwd: dir, encoding: 'utf8' });
const out = (res.stdout ?? '') + (res.stderr ?? '');
const alias = /Aliased: (https:\/\/\S+)/.exec(out)?.[1] ?? /Production: (https:\/\/\S+)/.exec(out)?.[1];
if (res.status !== 0 || !alias) {
  console.error(out);
  process.exit(res.status || 1);
}
console.log(`publicado: ${alias}`);
