import { describe, it, expect } from 'vitest';
import { CLOSED_QUESTION_RULE, WARM_NO_RULE } from '../../core/prompt-rules.js';
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

describe('buildReactivationInstructions — closed questions, never the "¿sí o no?" label', () => {
  it('demands a one-word answer WITHOUT ever asking for the label', () => {
    const out = buildReactivationInstructions('Clínica Luz', null, ['angle A']);
    expect(out).toContain(CLOSED_QUESTION_RULE);
    // The old spec is what the model rendered verbatim into the nudge.
    expect(out).not.toContain('fácil de responder con una sola palabra o sí/no');
  });

  it('tells the model a tenant angle phrased "pregunta de sí o no" is a SHAPE, not text', () => {
    // Several live angles read exactly like this one; the rule has to outrank them.
    const out = buildReactivationInstructions('MADI Skin Care', null, [
      'Retoma con ligereza: pregunta si quiere que le aparten un espacio. Pregunta de sí o no.',
    ]);
    expect(out).toContain('describe la FORMA de la pregunta, no un texto que debas copiar');
  });

  it('applies on a late round too — softer tone, same ban', () => {
    const out = buildReactivationInstructions('Clínica Luz', null, ['angle A'], undefined, {
      round: 1, isFinalTouch: false, reentryKeyword: 'CITA',
    });
    expect(out).toContain(CLOSED_QUESTION_RULE);
  });

  it('the farewell stays out of it — it asks nothing at all', () => {
    const out = buildReactivationInstructions('Clínica Luz', null, [], undefined, {
      round: 2, isFinalTouch: true, reentryKeyword: 'CITA',
    });
    expect(out).not.toContain(CLOSED_QUESTION_RULE);
  });

  it('the warm-refusal rule rides on every nudge, the farewell included', () => {
    expect(buildReactivationInstructions('Clínica Luz', null, ['angle A'])).toContain(WARM_NO_RULE);
    expect(
      buildReactivationInstructions('Clínica Luz', null, [], undefined, { round: 2, isFinalTouch: true, reentryKeyword: 'CITA' }),
    ).toContain(WARM_NO_RULE);
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

describe('buildReactivationInstructions — reactivation rounds (0049)', () => {
  const roundCtx = (round: number, isFinalTouch = false) => ({
    round, isFinalTouch, reentryKeyword: 'CITA',
  });

  it('round 0 is byte-identical to the classic prompt', () => {
    const classic = buildReactivationInstructions('Clínica Luz', 'divertido', ['angle A']);
    const round0 = buildReactivationInstructions('Clínica Luz', 'divertido', ['angle A'], undefined, roundCtx(0));
    expect(round0).toBe(classic);
  });

  it('round 1+ appends the soft-retry section and keeps the question mandate', () => {
    const out = buildReactivationInstructions('Clínica Luz', null, ['angle A'], undefined, roundCtx(1));
    expect(out).toContain('reintento tardío (ronda 2)');
    expect(out).toContain('Baja la intensidad');
    expect(out).toContain('"no por ahora"');
    // Still a normal nudge: angle machinery and question mandate intact.
    expect(out).toContain('ANGULO: n');
    expect(out).toContain('SIEMPRE termina con una pregunta');
  });

  it('the final touch is a farewell: teaches the re-entry word, no question, no angles', () => {
    const out = buildReactivationInstructions('Clínica Luz', null, [], undefined, roundCtx(2, true));
    expect(out).toContain('Mensaje FINAL de despedida');
    expect(out).toContain('"CITA"');
    expect(out).toContain('NO termines con una pregunta');
    expect(out).not.toContain('ANGULO: n');
    expect(out).not.toContain('SIEMPRE termina con una pregunta');
    expect(out).not.toContain('reavivar la conversación con una pregunta');
    expect(out).not.toContain('la pregunta final');
    // The farewell subsumes the soft-retry framing; no duplicate section.
    expect(out).not.toContain('reintento tardío');
  });

  it('the farewell wins even if candidates were passed by mistake', () => {
    const out = buildReactivationInstructions('Clínica Luz', null, ['angle A'], undefined, roundCtx(1, true));
    expect(out).toContain('Mensaje FINAL de despedida');
    expect(out).not.toContain('ANGULO: n');
  });
});
