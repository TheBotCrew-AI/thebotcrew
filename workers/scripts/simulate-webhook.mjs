// Fire a fake GHL inbound webhook at the locally-running Worker and print the
// response — the local dev path to watch the front-desk agent run end to end.
//
// Usage:
//   pnpm --filter @thebotcrew/workers webhook:simulate
//   WEBHOOK_URL=http://localhost:4111/webhooks/ghl pnpm ... webhook:simulate
//   node scripts/simulate-webhook.mjs path/to/payload.json

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const url = process.env.WEBHOOK_URL ?? 'http://localhost:4111/webhooks/ghl';
const fixturePath =
  process.argv[2] ?? resolve(__dirname, '../fixtures/ghl-inbound.example.json');

const payload = JSON.parse(await readFile(fixturePath, 'utf8'));

console.log(`POST ${url}`);
console.log('payload:', JSON.stringify(payload));

try {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  console.log(`\nstatus: ${res.status}`);
  console.log('body:', text);
  process.exit(res.ok ? 0 : 1);
} catch (err) {
  console.error('\nRequest failed — is the Worker running? (`pnpm dev`)');
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
