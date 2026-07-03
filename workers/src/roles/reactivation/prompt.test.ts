import { describe, it, expect } from 'vitest';
import { buildReactivationInstructions } from './prompt.js';

describe('buildReactivationInstructions', () => {
  it('with candidates → numbered list + mandatory ANGULO output format', () => {
    const out = buildReactivationInstructions('Clínica Luz', 'divertido', ['pregunta por su meta', 'ofrece resolver dudas']);
    expect(out).toContain('Clínica Luz');
    expect(out).toContain('divertido');
    expect(out).toContain('1. pregunta por su meta');
    expect(out).toContain('2. ofrece resolver dudas');
    expect(out).toContain('ANGULO: n');
  });

  it('no candidates → free-form fresh-nudge section', () => {
    const out = buildReactivationInstructions('Clínica Luz', null, []);
    expect(out).toContain('Sin ángulos predefinidos');
    expect(out).not.toContain('ANGULO: n');
  });

  it('falls back to a default tone when none is given', () => {
    expect(buildReactivationInstructions('X', null, [])).toContain('cálido, natural y cercano');
  });
});
