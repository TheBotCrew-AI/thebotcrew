import { describe, it, expect } from 'vitest';
import {
  DEFAULT_FOLLOW_UP_ROUNDS,
  cadenceForRound,
  isFinalRound,
  resolveExtraRounds,
  totalRounds,
} from './reactivation-rounds.js';

const CADENCE = [30, 360, 1080];

describe('resolveExtraRounds', () => {
  it('uses the platform default when the tenant has no override', () => {
    expect(resolveExtraRounds({ followUpCadence: CADENCE })).toBe(DEFAULT_FOLLOW_UP_ROUNDS);
    expect(resolveExtraRounds({ followUpCadence: CADENCE, followUpRounds: null })).toBe(DEFAULT_FOLLOW_UP_ROUNDS);
  });

  it('a tenant override replaces the default entirely, including the round count', () => {
    const rounds = [[120], [240], [480]];
    expect(resolveExtraRounds({ followUpCadence: CADENCE, followUpRounds: rounds })).toBe(rounds);
  });

  it('an explicit [] opts out of extra rounds (round 0 only)', () => {
    expect(resolveExtraRounds({ followUpCadence: CADENCE, followUpRounds: [] })).toEqual([]);
  });

  it('follow-ups off (null/empty cadence) means no extra rounds either', () => {
    expect(resolveExtraRounds({ followUpCadence: null })).toEqual([]);
    expect(resolveExtraRounds({ followUpCadence: [], followUpRounds: [[60]] })).toEqual([]);
  });
});

describe('cadenceForRound', () => {
  it('round 0 is the tenant cadence', () => {
    expect(cadenceForRound({ followUpCadence: CADENCE }, 0)).toEqual(CADENCE);
  });

  it('rounds 1+ come from the platform default taper', () => {
    expect(cadenceForRound({ followUpCadence: CADENCE }, 1)).toEqual([360, 1080]);
    expect(cadenceForRound({ followUpCadence: CADENCE }, 2)).toEqual([960]);
  });

  it('rounds 1+ come from the tenant override when set', () => {
    const config = { followUpCadence: CADENCE, followUpRounds: [[15, 30]] };
    expect(cadenceForRound(config, 1)).toEqual([15, 30]);
  });

  it('a round past the end returns [] (no cadence, nothing to arm)', () => {
    expect(cadenceForRound({ followUpCadence: CADENCE }, 3)).toEqual([]);
    expect(cadenceForRound({ followUpCadence: CADENCE, followUpRounds: [] }, 1)).toEqual([]);
  });

  it('follow-ups off returns [] even for round 0', () => {
    expect(cadenceForRound({ followUpCadence: null }, 0)).toEqual([]);
    expect(cadenceForRound({ followUpCadence: [] }, 0)).toEqual([]);
  });
});

describe('totalRounds — the arming gate is round >= totalRounds', () => {
  it('default: round 0 + two tapered rounds', () => {
    expect(totalRounds({ followUpCadence: CADENCE })).toBe(3);
  });

  it('tenant override controls the count', () => {
    expect(totalRounds({ followUpCadence: CADENCE, followUpRounds: [[60]] })).toBe(2);
    expect(totalRounds({ followUpCadence: CADENCE, followUpRounds: [] })).toBe(1);
  });

  it('follow-ups off = zero rounds (gate always closed)', () => {
    expect(totalRounds({ followUpCadence: null })).toBe(0);
    expect(totalRounds({ followUpCadence: [] })).toBe(0);
  });
});

describe('isFinalRound — the farewell round', () => {
  it('marks the last configured round and only that one', () => {
    const config = { followUpCadence: CADENCE };
    expect(isFinalRound(config, 0)).toBe(false);
    expect(isFinalRound(config, 1)).toBe(false);
    expect(isFinalRound(config, 2)).toBe(true);
    expect(isFinalRound(config, 3)).toBe(false);
  });

  it('with no extra rounds, round 0 is final', () => {
    expect(isFinalRound({ followUpCadence: CADENCE, followUpRounds: [] }, 0)).toBe(true);
  });

  it('follow-ups off: no round is final', () => {
    expect(isFinalRound({ followUpCadence: null }, 0)).toBe(false);
  });
});
