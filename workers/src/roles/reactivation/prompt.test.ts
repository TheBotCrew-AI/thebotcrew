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

describe('buildReactivationInstructions — demo context', () => {
  it('omits the demo block for a normal conversation', () => {
    const out = buildReactivationInstructions('The Bot Crew', null, ['angle A']);
    expect(out).not.toContain('CONTEXTO CRÍTICO');
  });

  it('reframes the lead as a business owner and bans chasing the roleplay', () => {
    const out = buildReactivationInstructions('The Bot Crew', null, ['angle A'], {
      businessName: 'BeautyFull', booked: true,
    });
    expect(out).toContain('CONTEXTO CRÍTICO');
    expect(out).toContain('"BeautyFull"');
    expect(out).toContain('DUEÑO DE NEGOCIO evaluando contratarnos');
    expect(out).toContain('fue SIMULADA');
    expect(out).toContain('PROHIBIDO ABSOLUTAMENTE');
  });

  it('without a booking it still voids the roleplay details', () => {
    const out = buildReactivationInstructions('The Bot Crew', null, [], { businessName: 'X' });
    expect(out).toContain('Nada de lo que se habló ahí');
    expect(out).not.toContain('fue SIMULADA');
  });
});
