import { describe, it, expect } from 'vitest';
import {
  DEFAULT_STAGE_OBJECTIVES,
  isLegacyPoolKey,
  parseFollowUpPlaybook,
  resolveStagePlan,
  serviceFacts,
} from './followup-playbook.js';

const tenant = {
  followUpCadence: [30, 360, 720],
  followUpAngles: ['tenant A', 'tenant B'],
  promptVariants: { lc3: { followUpAngles: ['variant A'] } },
};

const playbook = parseFollowUpPlaybook({
  stages: {
    NI: { cadence: [10, 60, 240, 1200], objective: 'informa', angles: ['ni 1', 'ni 2'] },
    C: { cadence: [10, 60], angles: ['c 1'] },
    A: { objective: 'retoma su caso' },
  },
  byInterest: {
    Botox: { NI: { angles: ['botox ni 1'] }, C: { cadence: [5] } },
  },
});

describe('parseFollowUpPlaybook', () => {
  it('null / garbage / empty → null (the flat ladder)', () => {
    expect(parseFollowUpPlaybook(null)).toBeNull();
    expect(parseFollowUpPlaybook('x')).toBeNull();
    expect(parseFollowUpPlaybook({ stages: { HOT: { cadence: [1] } } })).toBeNull();
    expect(parseFollowUpPlaybook({ stages: { NI: { cadence: ['a'], angles: [] } } })).toBeNull();
  });
  it('keeps only valid stage keys, case-tolerant, and drops empty fields', () => {
    const p = parseFollowUpPlaybook({ stages: { ni: { angles: ['x', '', 3] }, I: { cadence: [-1, 0, 15] } } });
    expect(p?.stages.NI?.angles).toEqual(['x']);
    expect(p?.stages.I?.cadence).toEqual([0, 15]);
  });
});

describe('resolveStagePlan', () => {
  it('no playbook → tenant cadence, variant-then-tenant pool, no objective (pre-0068)', () => {
    const r = resolveStagePlan(null, 'NI', 'Botox', tenant, 'lc3');
    expect(r).toEqual({ cadence: [30, 360, 720], angles: ['variant A'], poolKey: 'variant:lc3', objective: null, angleSource: 'variant' });
    expect(resolveStagePlan(null, 'C', null, tenant, null).poolKey).toBe('tenant');
  });

  it('no stage yet → same as no playbook', () => {
    const r = resolveStagePlan(playbook, null, 'Botox', tenant, null);
    expect(r.objective).toBeNull();
    expect(r.cadence).toEqual([30, 360, 720]);
  });

  it('stage plan wins over the variant pool and reshapes round 0', () => {
    const r = resolveStagePlan(playbook, 'NI', null, tenant, 'lc3');
    expect(r.cadence).toEqual([10, 60, 240, 1200]);
    expect(r.angles).toEqual(['ni 1', 'ni 2']);
    expect(r.poolKey).toBe('stage:NI');
    expect(r.objective).toBe('informa');
    expect(r.angleSource).toBe('stage');
  });

  it('a treatment pool wins over the stage pool, accent- and case-tolerant', () => {
    const r = resolveStagePlan(playbook, 'NI', 'bótox', tenant, 'lc3');
    expect(r.angles).toEqual(['botox ni 1']);
    expect(r.poolKey).toBe('interest:bótox/NI');
    expect(r.cadence).toEqual([10, 60, 240, 1200]); // cadence falls through to the stage
    expect(r.angleSource).toBe('interest');
  });

  it('per-field fallback: interest cadence, stage angles', () => {
    const r = resolveStagePlan(playbook, 'C', 'Botox', tenant, null);
    expect(r.cadence).toEqual([5]);
    expect(r.angles).toEqual(['c 1']);
    expect(r.poolKey).toBe('stage:C');
  });

  it('a stage with only an objective keeps the legacy pool and cadence but gains the objective', () => {
    const r = resolveStagePlan(playbook, 'A', null, tenant, 'lc3');
    expect(r.angles).toEqual(['variant A']);
    expect(r.poolKey).toBe('variant:lc3');
    expect(r.cadence).toEqual([30, 360, 720]);
    expect(r.objective).toBe('retoma su caso');
  });

  it('a stage the playbook does not mention gets the platform objective', () => {
    const r = resolveStagePlan(playbook, 'I', null, tenant, null);
    expect(r.objective).toBe(DEFAULT_STAGE_OBJECTIVES.I);
    expect(r.poolKey).toBe('tenant');
  });
});

describe('helpers', () => {
  it('legacy pool keys are the ones pre-0068 rows (NULL angle_pool) belong to', () => {
    expect(isLegacyPoolKey('tenant')).toBe(true);
    expect(isLegacyPoolKey('variant:lc3')).toBe(true);
    expect(isLegacyPoolKey('stage:NI')).toBe(false);
    expect(isLegacyPoolKey('interest:Botox/NI')).toBe(false);
  });
  it('serviceFacts finds the configured service by the persisted interest', () => {
    const services = [{ name: 'Láser CO₂ Fraccionado', description: 'Evaluación $500.' }, { name: 'Botox' }];
    expect(serviceFacts(services, 'laser co2 fraccionado')).toEqual({ name: 'Láser CO₂ Fraccionado', description: 'Evaluación $500.' });
    expect(serviceFacts(services, 'Botox')).toEqual({ name: 'Botox', description: null });
    expect(serviceFacts(services, 'Sculptra')).toBeNull();
    expect(serviceFacts(null, 'Botox')).toBeNull();
  });
});
