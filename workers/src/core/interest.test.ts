import { describe, it, expect } from 'vitest';
import { interestPromptAddendum, matchInterest, serviceNames } from './interest.js';

const SERVICES = ['Botox', 'Ácido Hialurónico', 'Láser CO₂ Fraccionado', 'Consulta de Bariatría'];

describe('serviceNames', () => {
  it('reads the configured names in order and skips malformed entries', () => {
    expect(
      serviceNames([{ name: 'Botox' }, { nope: 1 }, { name: '  ' }, { name: 'Sculptra', description: 'x' }, 'str']),
    ).toEqual(['Botox', 'Sculptra']);
  });

  it('tolerates a non-array services column', () => {
    expect(serviceNames(null)).toEqual([]);
    expect(serviceNames({})).toEqual([]);
  });
});

describe('matchInterest — only a CONFIGURED service becomes a tag', () => {
  it('returns the configured spelling for a case/accent-insensitive match', () => {
    expect(matchInterest(SERVICES, 'botox')).toBe('Botox');
    expect(matchInterest(SERVICES, 'acido hialuronico')).toBe('Ácido Hialurónico');
    expect(matchInterest(SERVICES, '  Láser CO₂ Fraccionado ')).toBe('Láser CO₂ Fraccionado');
  });

  it('drops anything that is not in the list — a hallucinated treatment never tags', () => {
    expect(matchInterest(SERVICES, 'Rinomodelación')).toBeNull();
    expect(matchInterest(SERVICES, 'Botox y ácido')).toBeNull(); // no partial / multi
    expect(matchInterest(SERVICES, null)).toBeNull();
    expect(matchInterest(SERVICES, 42)).toBeNull();
    expect(matchInterest(SERVICES, '')).toBeNull();
    expect(matchInterest([], 'Botox')).toBeNull();
  });
});

describe('interestPromptAddendum', () => {
  it('lists every service verbatim and asks for the two-field JSON', () => {
    const out = interestPromptAddendum(SERVICES);
    for (const s of SERVICES) expect(out).toContain(`- ${s}`);
    expect(out).toContain('"interest":null');
    expect(out).toContain('No inventes servicios');
  });
});
