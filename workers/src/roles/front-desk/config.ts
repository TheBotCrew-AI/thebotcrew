/**
 * Front-desk role config schema.
 *
 * Validates the slice of `tenant_config` this role consumes. The agent only
 * states facts that come from this config or from tool results — so a clean,
 * validated config is the anti-hallucination foundation.
 */

import { z } from 'zod';
import type { RawTenantConfig } from '../../core/types.js';

export const serviceSchema = z.object({
  name: z.string(),
  durationMin: z.number().int().positive().optional(),
  description: z.string().optional(),
});

export const dayHoursSchema = z.array(
  z.object({ open: z.string(), close: z.string() }),
);

/** Weekly schedule keyed by weekday (mon, tue, …). */
export const hoursSchema = z.record(z.string(), dayHoursSchema);

export const faqSchema = z.array(z.object({ q: z.string(), a: z.string() }));

export const promptOverridesSchema = z.object({
  /** Replaces the opening identity line. Use to disclose AI nature, role, and channels. */
  identity: z.string().optional(),
  /** Replaces the services section. Use for rich offering/pricing descriptions. */
  offering: z.string().optional(),
  /** Appended after the built-in qualification flow. Use for tenant-specific instructions. */
  qualificationNotes: z.string().optional(),
  /**
   * Tenant-wide rules that outrank the conversational flow — who we will and won't
   * serve, what we never promise. Rendered from BASE config even when a campaign
   * variant is pinned, which is the whole point: a variant replaces a whole field,
   * so a rule written inside `qualificationNotes` silently vanishes the day a
   * campaign overrides that field (no event, no failure — it just stops happening).
   * Deliberately absent from `promptVariantSchema` so a variant cannot set it.
   *
   * Suppressed in demo mode: house rules describe the REAL business, and inside a
   * roleplay for someone else's business they are incoherent.
   */
  houseRules: z.string().optional(),
  /**
   * Per-tool business rules, keyed by tool id (e.g. "getAvailability").
   * Injected as a dedicated prompt section so the agent knows how to interpret
   * and present each tool's results for this specific tenant.
   */
  toolInstructions: z.record(z.string(), z.string()).default({}),
  /**
   * When true, a deterministic post-turn backstop corrects the GHL contact name during the
   * opening exchanges (page-form leads often arrive named after their business). The prompt
   * also asks the agent to confirm the name, but the backstop is what guarantees the write —
   * OpenAI models routinely skip the side-effect-only updateContactName tool.
   */
  confirmContactName: z.boolean().default(false),
  /**
   * Whether this tenant books through the bot at all. Default true = current behavior.
   *
   * Set false for tenants with no calendar the bot can trust — e.g. MADI, who rents a
   * shared laser booth on a third party's calendar. It strips every booking instruction
   * from the prompt (the availability sequence, the strict-availability rules, the
   * reschedule/cancel rules) instead of leaving them to contradict a tenant override that
   * says "don't book". Those sections are emphatic ("Cuando el lead pida cita, llama
   * getAvailability") and render AFTER the tenant's own notes, so config alone can't
   * reliably override them — which is how a bot ends up promising a slot it can't hold.
   */
  bookingEnabled: z.boolean().default(true),
});

/**
 * A campaign prompt variant: a PARTIAL override set merged field-by-field over
 * the base promptOverrides at prompt-build time. Deliberately has NO defaults —
 * a zod default here would materialize on parse and clobber the base value in
 * the merge. Only prompt-affecting fields are overridable; behavior toggles that
 * live outside the prompt (confirmContactName) stay base-level on purpose, so a
 * variant can never half-enable a backstop the handler reads from base config.
 */
export const promptVariantSchema = z.object({
  identity: z.string().optional(),
  offering: z.string().optional(),
  qualificationNotes: z.string().optional(),
  /** Merged PER-KEY over the base toolInstructions (base rules survive unless overridden). */
  toolInstructions: z.record(z.string(), z.string()).optional(),
  bookingEnabled: z.boolean().optional(),
  /**
   * Campaign-specific reactivation angles. When present and non-empty, follow-ups
   * for conversations pinned to this variant draw from THIS pool instead of the
   * tenant's follow_up_angles (replace, not merge — sent-angle indexes are
   * positions within one pool). See roles/reactivation/angle-select.ts.
   */
  followUpAngles: z.array(z.string()).optional(),
});

export const frontDeskConfigSchema = z.object({
  businessName: z.string().min(1),
  timezone: z.string().min(1),
  tone: z.string().nullable().optional(),
  services: z.array(serviceSchema).default([]),
  hours: hoursSchema.default({}),
  /** Map of service name -> GHL calendar id. */
  calendars: z.record(z.string(), z.string()).default({}),
  faq: faqSchema.default([]),
  promptOverrides: promptOverridesSchema.default({ toolInstructions: {}, confirmContactName: false, bookingEnabled: true }),
  /** Persona overrides used when the conversation is in demo mode (active_role='demo'). null = none. */
  demoPromptOverrides: promptOverridesSchema.nullable().default(null),
  /** Named campaign variants keyed by variant key (see keyword_variants). null = none. */
  promptVariants: z.record(z.string(), promptVariantSchema).nullable().default(null),
  /** Max days ahead the bot may look for / offer slots. null = no cap. Enforced in getAvailability. */
  bookingHorizonDays: z.number().int().positive().nullable().default(null),
});

export type FrontDeskConfig = z.infer<typeof frontDeskConfigSchema>;
export type FrontDeskService = z.infer<typeof serviceSchema>;
export type PromptOverrides = z.infer<typeof promptOverridesSchema>;
export type PromptVariant = z.infer<typeof promptVariantSchema>;

/**
 * Resolve the override set in effect for this turn. Priority:
 *   1. demo persona (activeRole === 'demo' with demoPromptOverrides configured)
 *   2. the conversation's pinned campaign variant, merged over base
 *   3. base promptOverrides
 * A pinned variant whose key is missing from promptVariants falls back to base
 * (the misconfiguration was already logged as variant_assigned{known:false}).
 */
export function resolveEffectiveOverrides(
  config: FrontDeskConfig,
  activeRole?: string,
  promptVariant?: string,
): { overrides: PromptOverrides; usingDemo: boolean } {
  if (activeRole === 'demo' && config.demoPromptOverrides) {
    return { overrides: config.demoPromptOverrides, usingDemo: true };
  }
  const base = config.promptOverrides;
  const variant = promptVariant ? config.promptVariants?.[promptVariant] : undefined;
  if (!variant) return { overrides: base, usingDemo: false };
  return {
    overrides: {
      ...base,
      ...variant,
      // Per-key merge: campaign rules override individual tools, not the whole map.
      toolInstructions: { ...base.toolInstructions, ...(variant.toolInstructions ?? {}) },
      // House rules are the tenant's, not the campaign's. promptVariantSchema has no
      // such field, so the spread above can't touch it today — this line is what keeps
      // that true if someone ever adds one, and makes the guarantee visible here.
      houseRules: base.houseRules,
    },
    usingDemo: false,
  };
}

/** Validate + narrow the raw tenant config into the front-desk shape. */
export function parseFrontDeskConfig(raw: RawTenantConfig): FrontDeskConfig {
  return frontDeskConfigSchema.parse({
    businessName: raw.businessName,
    timezone: raw.timezone,
    tone: raw.tone,
    services: raw.services,
    hours: raw.hours,
    calendars: raw.calendars,
    faq: raw.faq,
    promptOverrides: raw.promptOverrides ?? {},
    demoPromptOverrides: raw.demoPromptOverrides ?? null,
    promptVariants: raw.promptVariants ?? null,
    bookingHorizonDays: raw.bookingHorizonDays ?? null,
  });
}
