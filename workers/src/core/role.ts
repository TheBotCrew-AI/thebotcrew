/**
 * Role abstraction + registry.
 *
 * A role = a Mastra agent + its tools + a config schema, exposed through one
 * uniform interface so new roles (follow-up, reactivation, …) plug in without
 * touching the core. One agent-with-tools per role (not router + specialists).
 */

import type { Agent } from '@mastra/core/agent';
import type { z } from 'zod';

export interface Role<TConfig = unknown> {
  /** Stable identifier, also stored in tenant_config.enabled_roles (e.g. 'front-desk'). */
  readonly name: string;
  /** Validates the slice of tenant_config this role consumes. */
  readonly configSchema: z.ZodType<TConfig>;
  /** Builds the role's Mastra agent (dynamic instructions/model resolve per request). */
  buildAgent(): Agent;
}

const registry = new Map<string, Role>();

export function registerRole(role: Role): void {
  if (registry.has(role.name)) {
    throw new Error(`Role already registered: ${role.name}`);
  }
  registry.set(role.name, role);
}

export function getRole(name: string): Role | undefined {
  return registry.get(name);
}

export function listRoles(): Role[] {
  return [...registry.values()];
}
