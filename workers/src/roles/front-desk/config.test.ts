import { describe, it, expect } from 'vitest';
import { parseFrontDeskConfig, resolveEffectiveOverrides } from './config.js';

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

describe('promptVariants schema', () => {
  it('parses variants and keeps them partial (no defaults materialized)', () => {
    const c = parseFrontDeskConfig({
      businessName: 'X',
      timezone: 'America/Mexico_City',
      promptVariants: { 'laser-promo': { offering: 'Solo laser.' } },
    } as never);
    expect(c.promptVariants?.['laser-promo']).toEqual({ offering: 'Solo laser.' });
    // No zod defaults may leak into a variant — they'd clobber base values on merge.
    expect(c.promptVariants?.['laser-promo']).not.toHaveProperty('toolInstructions');
    expect(c.promptVariants?.['laser-promo']).not.toHaveProperty('bookingEnabled');
  });

  it('defaults to null when absent', () => {
    const c = parseFrontDeskConfig({ businessName: 'X', timezone: 'America/Mexico_City' } as never);
    expect(c.promptVariants).toBeNull();
  });
});

describe('resolveEffectiveOverrides', () => {
  const base = {
    businessName: 'X',
    timezone: 'America/Mexico_City',
    promptOverrides: {
      identity: 'Base identity',
      offering: 'Base offering',
      toolInstructions: { getAvailability: 'base rule', lookupFaq: 'faq rule' },
    },
    promptVariants: {
      'laser-promo': {
        offering: 'Laser offering',
        toolInstructions: { getAvailability: 'laser rule' },
        bookingEnabled: false,
      },
    },
    demoPromptOverrides: { identity: 'Demo identity' },
  };

  function cfg() {
    return parseFrontDeskConfig(base as never);
  }

  it('returns base overrides with no variant and no demo', () => {
    const { overrides, usingDemo } = resolveEffectiveOverrides(cfg());
    expect(usingDemo).toBe(false);
    expect(overrides.identity).toBe('Base identity');
    expect(overrides.offering).toBe('Base offering');
  });

  it('merges the variant field-by-field over base (unset fields survive)', () => {
    const { overrides, usingDemo } = resolveEffectiveOverrides(cfg(), undefined, 'laser-promo');
    expect(usingDemo).toBe(false);
    expect(overrides.offering).toBe('Laser offering');     // overridden
    expect(overrides.identity).toBe('Base identity');      // survives — variant didn't set it
    expect(overrides.bookingEnabled).toBe(false);          // variant may disable booking
  });

  it('merges toolInstructions PER KEY, not wholesale', () => {
    const { overrides } = resolveEffectiveOverrides(cfg(), undefined, 'laser-promo');
    expect(overrides.toolInstructions).toEqual({
      getAvailability: 'laser rule',  // overridden
      lookupFaq: 'faq rule',          // base rule survives
    });
  });

  it('falls back to base when the pinned variant key is unknown', () => {
    const { overrides } = resolveEffectiveOverrides(cfg(), undefined, 'deleted-campaign');
    expect(overrides.offering).toBe('Base offering');
  });

  it('demo persona wins over a pinned variant', () => {
    const { overrides, usingDemo } = resolveEffectiveOverrides(cfg(), 'demo', 'laser-promo');
    expect(usingDemo).toBe(true);
    expect(overrides.identity).toBe('Demo identity');
  });

  it('confirmContactName always comes from base (variants cannot toggle backstops)', () => {
    const withBackstop = parseFrontDeskConfig({
      ...base,
      promptOverrides: { ...base.promptOverrides, confirmContactName: true },
    } as never);
    const { overrides } = resolveEffectiveOverrides(withBackstop, undefined, 'laser-promo');
    expect(overrides.confirmContactName).toBe(true);
  });
});
