import type { TenantScenarios } from '../scenario.js';
import { heriberto } from './heriberto.js';

/** One entry per tenant with a battery; the key is what `pnpm battery <slug>` takes. */
export const TENANT_SCENARIOS: Record<string, TenantScenarios> = {
  [heriberto.slug]: heriberto,
};
