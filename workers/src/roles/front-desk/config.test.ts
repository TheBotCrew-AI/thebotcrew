import { describe, it, expect } from 'vitest';
import { parseFrontDeskConfig } from './config.js';

describe('parseFrontDeskConfig', () => {
  it('applies defaults for optional fields', () => {
    const c = parseFrontDeskConfig({ businessName: 'X', timezone: 'America/Mexico_City' } as never);
    expect(c.services).toEqual([]);
    expect(c.calendars).toEqual({});
    expect(c.faq).toEqual([]);
    expect(c.bookingHorizonDays).toBeNull();
    expect(c.promptOverrides.toolInstructions).toEqual({});
    expect(c.promptOverrides.confirmContactName).toBe(false);
  });

  it('passes through confirmContactName when set', () => {
    const c = parseFrontDeskConfig({ businessName: 'X', timezone: 'America/Mexico_City', promptOverrides: { confirmContactName: true } } as never);
    expect(c.promptOverrides.confirmContactName).toBe(true);
  });

  it('throws when businessName is missing', () => {
    expect(() => parseFrontDeskConfig({ timezone: 'America/Mexico_City' } as never)).toThrow();
  });
});
