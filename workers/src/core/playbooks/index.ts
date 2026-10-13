/**
 * Platform playbook presets (0070), by the name a tenant writes in
 * `follow_up_playbook.preset`. Code = the product: a preset ships to every tenant
 * that names it; what the tenant writes on top overrides it per stage and field.
 * An unknown name is ignored (the tenant's own text, or the flat ladder, runs).
 */

import { MEDICINA_ESTETICA_PLAYBOOK } from './medicina-estetica.js';

export const PLAYBOOK_PRESETS: Readonly<Record<string, unknown>> = {
  'medicina-estetica': MEDICINA_ESTETICA_PLAYBOOK,
};

export function presetPlaybook(name: string): unknown {
  return PLAYBOOK_PRESETS[name.trim().toLowerCase()] ?? null;
}
