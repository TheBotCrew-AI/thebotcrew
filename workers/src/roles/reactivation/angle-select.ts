/**
 * Parses the reactivation agent's reply under the hybrid angle-selection protocol.
 *
 * When given a candidate list, the agent is told to emit `ANGULO: n` on the first
 * line (its chosen 1-based candidate), then the message. We parse that here — and
 * always strip any tag so it can never leak to the lead. Pure and unit-tested.
 */

const TAG = /^\s*ANGULO:\s*(\d+)\s*(?:\r?\n|$)/i;

export interface AngleSelection {
  /** 1-based candidate number the agent chose, or null (invalid/absent/free-form). */
  angleChoice: number | null;
  /** The lead-facing message, with any selection tag stripped. */
  message: string;
}

/**
 * Which angle pool feeds this conversation's follow-ups (0040, code-only):
 * a campaign variant may carry its own `followUpAngles` so nudges can speak
 * the campaign's language ("¿sigues interesada en la promo de laser?"). The
 * variant pool REPLACES the tenant pool when present and non-empty — pools
 * don't merge, because sent-angle indexes are positions within ONE pool and a
 * conversation's variant is first-touch sticky, so its pool identity is stable.
 * Malformed/missing config falls back to the tenant pool, never to silence.
 */
export function resolveAnglePool(
  promptVariants: unknown,
  variantKey: string | null | undefined,
  tenantPool: string[],
): { pool: string[]; source: 'variant' | 'tenant' } {
  if (variantKey && promptVariants && typeof promptVariants === 'object' && !Array.isArray(promptVariants)) {
    const variant = (promptVariants as Record<string, unknown>)[variantKey];
    if (variant && typeof variant === 'object') {
      const raw = (variant as { followUpAngles?: unknown }).followUpAngles;
      if (Array.isArray(raw)) {
        const pool = raw.filter((a): a is string => typeof a === 'string' && a.trim().length > 0);
        if (pool.length > 0) return { pool, source: 'variant' };
      }
    }
  }
  return { pool: tenantPool, source: 'tenant' };
}

export function parseAngleSelection(text: string, candidateCount: number): AngleSelection {
  const match = TAG.exec(text);
  let message = match ? text.slice(match[0].length) : text;
  // Defensive: strip a residual leading tag even if the first match didn't fire.
  message = message.replace(TAG, '').trim();

  let angleChoice: number | null = null;
  if (match) {
    const n = Number(match[1]);
    if (Number.isInteger(n) && n >= 1 && n <= candidateCount) angleChoice = n;
  }
  return { angleChoice, message };
}
