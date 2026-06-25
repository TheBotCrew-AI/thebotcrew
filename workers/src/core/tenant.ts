/**
 * Tenant resolver: GHL location (subaccount) id -> TenantContext.
 *
 * Thin wrapper over the DB query so the worker/handler depends on a stable
 * resolver rather than the query layer directly.
 */

import { loadTenantConfig } from '../db/queries.js';
import type { Channel, TenantContext } from './types.js';

/** Returns the active tenant for a GHL location, or null if unknown/inactive. */
export async function resolveTenant(ghlLocationId: string): Promise<TenantContext | null> {
  return loadTenantConfig(ghlLocationId);
}

/** True if the role is enabled for this tenant. */
export function roleEnabled(tenant: TenantContext, role: string): boolean {
  return tenant.enabledRoles.includes(role);
}

/** True if the bot may reply on this channel for this tenant (null = none). */
export function channelEnabled(tenant: TenantContext, channel: Channel): boolean {
  return tenant.enabledChannels?.includes(channel) ?? false;
}

/**
 * Whether the tenant is in pre-live test mode (a non-empty test allowlist).
 * In test mode the bot replies only to allow-listed contacts, bypassing the
 * channel gate.
 */
export function inTestMode(tenant: TenantContext): boolean {
  return (tenant.testContactIds?.length ?? 0) > 0;
}
