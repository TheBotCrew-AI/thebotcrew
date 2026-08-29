/**
 * Fill `process.env` from `workers/.env` for the battery, never overriding what the shell
 * already exported. The evals expect the shell to carry the keys; the battery is run as a
 * one-off command (`pnpm battery heriberto`) and should just work from the checkout.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function loadDotEnv(path = fileURLToPath(new URL('../../.env', import.meta.url))): void {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return;
  }
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}
