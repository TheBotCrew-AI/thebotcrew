/**
 * `tenant_config.info_gaps` after validation — the cadence of the info-gap report
 * (0054). Pure: no I/O, importable from db/queries.ts without a cycle.
 *
 * A run is due when at least `minCandidates` conversations qualified since the last
 * run, or when `maxDays` have passed and at least `minForTimeRun` did. The floor
 * exists because two conversations are an anecdote: the report's value is "the
 * human answered the SAME thing N times", and that needs N.
 */

export interface InfoGapsConfig {
  enabled: boolean;
  minCandidates: number;
  maxDays: number;
  minForTimeRun: number;
}

export const INFO_GAP_DEFAULTS = { minCandidates: 10, maxDays: 7, minForTimeRun: 3 } as const;

function positiveInt(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : fallback;
}

/**
 * Validate the stored jsonb. NULL, malformed, or `enabled: false` → null (feature
 * off). Same contract as parseMetaCapi: a broken config degrades to "off", loudly.
 */
export function parseInfoGaps(raw: unknown): InfoGapsConfig | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (o.enabled !== true) return null;
  return {
    enabled: true,
    minCandidates: positiveInt(o.min_candidates, INFO_GAP_DEFAULTS.minCandidates),
    maxDays: positiveInt(o.max_days, INFO_GAP_DEFAULTS.maxDays),
    minForTimeRun: positiveInt(o.min_for_time_run, INFO_GAP_DEFAULTS.minForTimeRun),
  };
}

/**
 * Whether a tenant is due for a run. `lastWindowTo` is where the next window starts
 * (null = never ran); `lastStartedAt` is the previous run's start, used for the
 * time-based trigger.
 */
export function isRunDue(
  config: InfoGapsConfig,
  candidates: number,
  lastStartedAt: Date | null,
  now: Date,
): boolean {
  if (candidates >= config.minCandidates) return true;
  if (candidates < config.minForTimeRun) return false;
  const since = lastStartedAt ?? new Date(0);
  const days = (now.getTime() - since.getTime()) / 86_400_000;
  return days >= config.maxDays;
}
