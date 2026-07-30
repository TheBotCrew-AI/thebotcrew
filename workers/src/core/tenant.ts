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

/** True if the tenant gates new conversations behind a trigger keyword. */
export function hasTriggerKeywords(tenant: TenantContext): boolean {
  return (tenant.triggerKeywords?.length ?? 0) > 0;
}

/** True if this message should switch the conversation INTO the demo persona. */
export function matchesDemoOn(tenant: TenantContext, text: string): boolean {
  return messageMatchesTrigger(text, tenant.demoOnKeywords ?? []);
}

/** True if this message should switch the conversation OUT of the demo persona. */
export function matchesDemoOff(tenant: TenantContext, text: string): boolean {
  return messageMatchesTrigger(text, tenant.demoOffKeywords ?? []);
}

/** Shared keyword normalizer: lowercase, punctuation flattened to spaces, space-padded. */
function normKeyword(s: string): string {
  return ' ' + s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim() + ' ';
}

/**
 * Whole-word/phrase, case- and accent-insensitive keyword match. Punctuation is
 * flattened to spaces and the text is space-padded, so "Agente" matches
 * "Hola, Agente!" but not "urgente", and phrases like "quiero info" still match.
 */
export function messageMatchesTrigger(text: string, keywords: string[]): boolean {
  const hay = normKeyword(text);
  return keywords.some((kw) => {
    const needle = normKeyword(kw);
    return needle.trim().length > 0 && hay.includes(needle);
  });
}

export interface VariantMatch {
  keyword: string;
  variant: string;
}

/**
 * Match the message against the tenant's campaign keywords (keyword_variants).
 * Same normalizer as the trigger gate. When several keywords match, the LONGEST
 * (most specific) normalized keyword wins — "me interesa promo de laser" beats
 * "info" — so a generic keyword can coexist with campaign phrases. Ties break
 * by config order. Returns null when the tenant has no variants or none match.
 */
export function matchVariantKeyword(tenant: TenantContext, text: string): VariantMatch | null {
  const map = tenant.keywordVariants;
  if (!map) return null;
  const hay = normKeyword(text);
  let best: (VariantMatch & { needleLen: number }) | null = null;
  for (const [keyword, variant] of Object.entries(map)) {
    if (!variant?.trim()) continue;
    const needle = normKeyword(keyword);
    const needleLen = needle.trim().length;
    if (needleLen === 0 || !hay.includes(needle)) continue;
    if (!best || needleLen > best.needleLen) {
      best = { keyword, variant: variant.trim(), needleLen };
    }
  }
  return best ? { keyword: best.keyword, variant: best.variant } : null;
}
