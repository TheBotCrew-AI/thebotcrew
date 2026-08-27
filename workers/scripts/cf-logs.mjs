/**
 * Read Cloudflare Workers Logs for thebotcrew-agents over a UTC window.
 *   node scripts/cf-logs.mjs 2026-08-27T15:18:25Z 2026-08-27T15:19:40Z [path-filter]
 * Auth: CF_OBSERVABILITY_TOKEN (env or workers/.env) — an API token with
 * "Workers Observability: Read". wrangler's OAuth login does NOT carry that scope (403).
 */
import fs from 'node:fs';

const envFile = new URL('../.env', import.meta.url);
const env = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '';
const token = process.env.CF_OBSERVABILITY_TOKEN ?? env.match(/^CF_OBSERVABILITY_TOKEN="?([^"\r\n]+)"?/m)?.[1];
if (!token) {
  console.error('CF_OBSERVABILITY_TOKEN missing (env or workers/.env)');
  process.exit(1);
}
const ACCOUNT = 'cc283929a3469ed5084692cc58bc0c16';
const [from, to, pathFilter] = process.argv.slice(2);
if (!from || !to) {
  console.error('usage: node scripts/cf-logs.mjs <fromISO> <toISO> [path-filter]');
  process.exit(1);
}

const body = {
  queryId: `cf-logs-${from}`,
  timeframe: { from: Date.parse(from), to: Date.parse(to) },
  parameters: {
    datasets: ['cloudflare-workers'],
    filters: [{ key: '$metadata.service', operation: 'eq', value: 'thebotcrew-agents', type: 'string' }],
    calculations: [],
    groupBys: [],
    havings: [],
  },
  view: 'events',
  limit: 500,
};
const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/observability/telemetry/query`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
const json = await res.json();
if (!res.ok || !json.success) {
  console.error('HTTP', res.status, JSON.stringify(json).slice(0, 600));
  process.exit(1);
}
const events = json.result?.events?.events ?? json.result?.events ?? [];
let shown = 0;
for (const e of events) {
  const m = e.$metadata ?? {};
  const w = e.$workers ?? {};
  const path = w.event?.request?.url ? new URL(w.event.request.url).pathname : '';
  if (pathFilter && !path.includes(pathFilter) && !(m.message ?? '').includes(pathFilter)) continue;
  const ts = new Date(e.timestamp).toISOString().slice(11, 23);
  const msg = String(m.message ?? '').replace(/\s+/g, ' ').slice(0, 300);
  console.log(`${ts} ${m.level ?? ''} ${w.eventType ?? m.type ?? ''} ${path} ${w.outcome ?? ''} :: ${msg}`);
  shown += 1;
}
console.log(`-- ${shown} of ${events.length} events`);
