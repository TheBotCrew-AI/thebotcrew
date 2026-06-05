/**
 * Tenant resolver: GHL location (subaccount) id -> TenantContext.
 *
 * Thin wrapper over the DB query so the worker/handler depends on a stable
 * resolver rather than the query layer directly.
 */

import { loadTenantConfig } from '../db/queries.js';
import type { TenantContext } from './types.js';

/** Returns the active tenant for a GHL location, or null if unknown/inactive. */
export async function resolveTenant(ghlLocationId: string): Promise<TenantContext | null> {
  return loadTenantConfig(ghlLocationId);
}

/** True if the role is enabled for this tenant. */
export function roleEnabled(tenant: TenantContext, role: string): boolean {
  return tenant.enabledRoles.includes(role);
}
