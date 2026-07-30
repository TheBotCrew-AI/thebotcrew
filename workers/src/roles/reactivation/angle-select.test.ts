import { describe, it, expect } from 'vitest';
import { parseAngleSelection, resolveAnglePool } from './angle-select.js';

describe('parseAngleSelection', () => {
  it('extracts a valid tag and strips it from the message', () => {
    const out = parseAngleSelection('ANGULO: 2\n¿Sigues por ahí? ¿Retomamos?', 4);
    expect(out.angleChoice).toBe(2);
    expect(out.message).toBe('¿Sigues por ahí? ¿Retomamos?');
  });

  it('is case-insensitive and tolerates spacing', () => {
    const out = parseAngleSelection('  angulo:  3  \nHola de nuevo, ¿te late?', 4);
    expect(out.angleChoice).toBe(3);
    expect(out.message).toBe('Hola de nuevo, ¿te late?');
  });

  it('rejects an out-of-range choice but still strips the tag (no leak)', () => {
    const out = parseAngleSelection('ANGULO: 9\n¿Te queda mejor mañana?', 4);
    expect(out.angleChoice).toBeNull();
    expect(out.message).toBe('¿Te queda mejor mañana?');
  });

  it('handles no tag (free-form) by returning the full trimmed message', () => {
    const out = parseAngleSelection('¿Cómo vas con la decisión?', 0);
    expect(out.angleChoice).toBeNull();
    expect(out.message).toBe('¿Cómo vas con la decisión?');
  });

  it('never leaks a residual tag into the message', () => {
    const out = parseAngleSelection('ANGULO: 1\nANGULO: 1\n¿Retomamos?', 4);
    expect(out.message).not.toMatch(/ANGULO/i);
  });

  it('accepts CRLF line endings', () => {
    const out = parseAngleSelection('ANGULO: 4\r\n¿Te aparto un espacio?', 4);
    expect(out.angleChoice).toBe(4);
    expect(out.message).toBe('¿Te aparto un espacio?');
  });
});

describe('resolveAnglePool', () => {
  const tenantPool = ['angle A', 'angle B'];
  const variants = {
    'laser-promo': { offering: 'x', followUpAngles: ['¿sigues interesada en la promo de laser?', 'la promo termina pronto'] },
    'sin-angles': { offering: 'y' },
    'empty-angles': { followUpAngles: [] },
    'junk-angles': { followUpAngles: [42, '  ', null] },
  };

  it('uses the variant pool when the conversation is pinned to a variant that has one', () => {
    const r = resolveAnglePool(variants, 'laser-promo', tenantPool);
    expect(r.source).toBe('variant');
    expect(r.pool).toEqual(['¿sigues interesada en la promo de laser?', 'la promo termina pronto']);
  });

  it('falls back to the tenant pool: no variant pinned', () => {
    expect(resolveAnglePool(variants, null, tenantPool)).toEqual({ pool: tenantPool, source: 'tenant' });
  });

  it('falls back: variant without angles, empty angles, junk-only angles, unknown key', () => {
    expect(resolveAnglePool(variants, 'sin-angles', tenantPool).source).toBe('tenant');
    expect(resolveAnglePool(variants, 'empty-angles', tenantPool).source).toBe('tenant');
    expect(resolveAnglePool(variants, 'junk-angles', tenantPool).source).toBe('tenant');
    expect(resolveAnglePool(variants, 'deleted-campaign', tenantPool).source).toBe('tenant');
  });

  it('falls back on malformed promptVariants config (null, array, scalar)', () => {
    expect(resolveAnglePool(null, 'laser-promo', tenantPool).source).toBe('tenant');
    expect(resolveAnglePool(['not', 'an', 'object'], 'laser-promo', tenantPool).source).toBe('tenant');
    expect(resolveAnglePool('junk', 'laser-promo', tenantPool).source).toBe('tenant');
  });

  it('filters non-string/blank entries out of a valid variant pool', () => {
    const r = resolveAnglePool({ v: { followUpAngles: ['real', '', 3, 'otra'] } }, 'v', tenantPool);
    expect(r).toEqual({ pool: ['real', 'otra'], source: 'variant' });
  });
});
