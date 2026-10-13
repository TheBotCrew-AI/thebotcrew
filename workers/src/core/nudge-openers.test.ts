import { describe, expect, it } from 'vitest';
import { openerOf, usedOpeners } from './nudge-openers.js';

describe('openerOf', () => {
  it('first three words, lowercased, punctuation and emoji stripped', () => {
    expect(openerOf('¡Qué bueno que me escribes! En la consulta…')).toBe('qué bueno que');
    expect(openerOf('😊 Hola, Ana. ¿Pudiste verlo?')).toBe('hola ana pudiste');
  });

  it('shorter messages give what there is', () => {
    expect(openerOf('¿Te aparto?')).toBe('te aparto');
    expect(openerOf('   ')).toBe('');
  });
});

describe('usedOpeners', () => {
  it('unique, in order, empties dropped', () => {
    expect(
      usedOpeners([
        'Qué bueno que me cuentas; las cicatrices…',
        '¡Hola! Soy Sofía, del consultorio.',
        'Qué bueno que sigues interesada; en la evaluación…',
        '',
        'Hola, qué bueno que retomamos.',
      ]),
    ).toEqual(['qué bueno que', 'hola soy sofía', 'hola qué bueno']);
  });
});
