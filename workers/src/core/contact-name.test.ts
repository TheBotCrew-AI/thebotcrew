import { describe, it, expect } from 'vitest';
import { splitContactName } from './contact-name.js';

describe('splitContactName', () => {
  it('first word is the first name, the rest the surname', () => {
    expect(splitContactName('Karla Mendoza López')).toEqual({ firstName: 'Karla', lastName: 'Mendoza López' });
  });
  it('a single word has an empty surname (clears a stale one on write)', () => {
    expect(splitContactName('Carlos')).toEqual({ firstName: 'Carlos', lastName: '' });
  });
  it('collapses whitespace', () => {
    expect(splitContactName('  Ana   Ruiz ')).toEqual({ firstName: 'Ana', lastName: 'Ruiz' });
  });
  it('nothing usable → null', () => {
    expect(splitContactName('   ')).toBeNull();
    expect(splitContactName(undefined)).toBeNull();
  });
});
