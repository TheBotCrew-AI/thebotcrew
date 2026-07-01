import { z } from 'zod';
import type { RawTenantConfig } from '../../core/types.js';

export const reactivationConfigSchema = z.object({
  businessName: z.string().min(1),
  timezone: z.string().min(1),
  tone: z.string().nullable().optional(),
});

export type ReactivationConfig = z.infer<typeof reactivationConfigSchema>;

export function parseReactivationConfig(raw: RawTenantConfig): ReactivationConfig {
  return reactivationConfigSchema.parse({
    businessName: raw.businessName,
    timezone: raw.timezone,
    tone: raw.tone,
  });
}
