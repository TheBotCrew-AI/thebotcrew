import { describe, it, expect } from 'vitest';
import { parseAngleSelection } from './angle-select.js';

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
