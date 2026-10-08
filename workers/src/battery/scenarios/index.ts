import type { TenantScenarios } from '../scenario.js';
import { heriberto } from './heriberto.js';
import { heribertoLaser } from './heriberto-laser.js';
import { heribertoSim } from './heriberto-sim.js';
import { happyNaty } from './happynaty.js';
import { primeTimeDemo } from './prime-time-demo.js';

/** One entry per tenant with a battery; the key is what `pnpm battery <slug>` takes. */
export const TENANT_SCENARIOS: Record<string, TenantScenarios> = {
  [heriberto.slug]: heriberto,
  [heribertoSim.slug]: heribertoSim,
  [heribertoLaser.slug]: heribertoLaser,
  [happyNaty.slug]: happyNaty,
  [primeTimeDemo.slug]: primeTimeDemo,
};
