/**
 * Reactivation rounds (0049): front-load + taper + stop.
 *
 * A "round" is one full ghost→pursuit cycle. Round 0 runs the tenant's own
 * follow_up_cadence (today's behaviour); each later round is shorter and softer,
 * and after the last one the lead is never pursued again (the bot still answers
 * if they write — only the nudges stop). The per-conversation counter lives in
 * `conversations.reactivation_round` and is consumed when the FIRST nudge of a
 * cycle actually sends (app_mark_follow_up_sent), so a lead who replies before
 * any nudge fires burns nothing. See docs/business-logic.md §4.3.
 */

/** Config slice the round math needs — a subset of RawTenantConfig. */
export interface RoundsConfig {
  /** Round 0's cadence (minutes per attempt); null/empty = follow-ups off. */
  followUpCadence?: number[] | null;
  /** Cadences for rounds 1+; null = platform default, [] = round 0 only. */
  followUpRounds?: number[][] | null;
}

/**
 * Platform-default cadences for rounds 1+ (round 0 is the tenant's own
 * follow_up_cadence). Round 1: two softer touches (6h, 18h). Round 2: one
 * final farewell (16h). Per-tenant override: tenant_config.follow_up_rounds.
 */
export const DEFAULT_FOLLOW_UP_ROUNDS: readonly (readonly number[])[] = [
  [360, 1080],
  [960],
];

/**
 * The word the final farewell teaches the lead ("escribe CITA para retomar").
 * Purely rhetorical: ANY inbound already reactivates the bot — only a booking
 * resets the round counter. A constant, not config, until a tenant needs it.
 */
export const REENTRY_KEYWORD = 'CITA';

/** Cadences for rounds 1+: the tenant override (including [] = none) or the
 *  platform default. A tenant with follow-ups off gets no extra rounds either. */
export function resolveExtraRounds(config: RoundsConfig): readonly (readonly number[])[] {
  if (!config.followUpCadence?.length) return [];
  if (config.followUpRounds) return config.followUpRounds;
  return DEFAULT_FOLLOW_UP_ROUNDS;
}

/** The cadence a given round runs on; [] when the round doesn't exist (out of
 *  range, or follow-ups off entirely). Round 0 = the tenant's followUpCadence. */
export function cadenceForRound(config: RoundsConfig, round: number): readonly number[] {
  if (round === 0) return config.followUpCadence ?? [];
  return resolveExtraRounds(config)[round - 1] ?? [];
}

/** How many rounds exist for this tenant. The arming gate is
 *  `reactivation_round >= totalRounds(config)`. 0 = follow-ups off. */
export function totalRounds(config: RoundsConfig): number {
  if (!config.followUpCadence?.length) return 0;
  return 1 + resolveExtraRounds(config).length;
}

/** Whether `round` is the LAST round this tenant runs — its final touch is the
 *  farewell message, and exhausting it unanswered ends pursuit for good. */
export function isFinalRound(config: RoundsConfig, round: number): boolean {
  const total = totalRounds(config);
  return total > 0 && round === total - 1;
}
