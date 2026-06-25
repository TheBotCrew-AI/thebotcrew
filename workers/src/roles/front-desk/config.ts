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
   * Per-tool business rules, keyed by tool id (e.g. "getAvailability").
   * Injected as a dedicated prompt section so the agent knows how to interpret
   * and present each tool's results for this specific tenant.
   */
  toolInstructions: z.record(z.string(), z.string()).default({}),
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
  promptOverrides: promptOverridesSchema.default({ toolInstructions: {} }),
});

export type FrontDeskConfig = z.infer<typeof frontDeskConfigSchema>;
export type FrontDeskService = z.infer<typeof serviceSchema>;
export type PromptOverrides = z.infer<typeof promptOverridesSchema>;

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
  });
}
