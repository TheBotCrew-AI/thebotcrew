import { z } from 'zod';
import type { RawTenantConfig } from '../../core/types.js';

export const followUpTierSchema = z.object({
  tier: z.number().int().min(1),
  delayMinutes: z.number().int().positive(),
  angle: z.string().min(1),
});

export const reactivationConfigSchema = z.object({
  businessName: z.string().min(1),
  timezone: z.string().min(1),
  tone: z.string().nullable().optional(),
  followUpTiers: z.array(followUpTierSchema).default([]),
});

export type ReactivationConfig = z.infer<typeof reactivationConfigSchema>;

export function parseReactivationConfig(raw: RawTenantConfig): ReactivationConfig {
  return reactivationConfigSchema.parse({
    businessName: raw.businessName,
    timezone: raw.timezone,
    tone: raw.tone,
    followUpTiers: raw.followUpTiers ?? [],
  });
}
