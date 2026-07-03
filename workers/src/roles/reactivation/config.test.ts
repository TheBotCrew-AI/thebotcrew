import { describe, it, expect } from 'vitest';
import { parseReactivationConfig } from './config.js';

describe('parseReactivationConfig', () => {
  it('narrows to businessName/timezone/tone', () => {
    const c = parseReactivationConfig({ businessName: 'X', timezone: 'America/Mexico_City', tone: 'cálido', services: [] } as never);
    expect(c).toEqual({ businessName: 'X', timezone: 'America/Mexico_City', tone: 'cálido' });
  });

  it('throws when businessName is missing', () => {
    expect(() => parseReactivationConfig({ timezone: 'America/Mexico_City' } as never)).toThrow();
  });
});
