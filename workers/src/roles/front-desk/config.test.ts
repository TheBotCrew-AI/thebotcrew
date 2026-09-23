import { describe, it, expect, vi } from 'vitest';
import { holdAmountCents, parseFrontDeskConfig, resolveEffectiveOverrides } from './config.js';

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

  it('houseRules always come from base — a campaign cannot drop the tenant rules', () => {
    const withRules = parseFrontDeskConfig({
      ...base,
      promptOverrides: { ...base.promptOverrides, houseRules: 'Solo servimos a quien agenda citas.' },
      // A variant that replaces the flow AND tries to smuggle in its own house rules.
      promptVariants: {
        'laser-promo': { ...base.promptVariants['laser-promo'], qualificationNotes: 'Flujo de campaña', houseRules: 'Vale todo' },
      },
    } as never);
    const { overrides } = resolveEffectiveOverrides(withRules, undefined, 'laser-promo');
    expect(overrides.qualificationNotes).toBe('Flujo de campaña'); // the flow IS the campaign's
    expect(overrides.houseRules).toBe('Solo servimos a quien agenda citas.'); // the rules are not
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

describe('promptVariants — followUpAngles', () => {
  it('accepts campaign-specific reactivation angles on a variant', () => {
    const c = parseFrontDeskConfig({
      businessName: 'X',
      timezone: 'America/Mexico_City',
      promptVariants: { 'laser-promo': { followUpAngles: ['¿sigues interesada en la promo?'] } },
    } as never);
    expect(c.promptVariants?.['laser-promo']?.followUpAngles).toEqual(['¿sigues interesada en la promo?']);
  });
});

describe('bookingPayment (0062)', () => {
  const base = { businessName: 'X', timezone: 'America/Mexico_City' };

  it('absent / null → null (citas confirm without payment)', () => {
    expect(parseFrontDeskConfig(base as never).bookingPayment).toBeNull();
    expect(parseFrontDeskConfig({ ...base, bookingPayment: null } as never).bookingPayment).toBeNull();
  });

  it('reads the snake_case jsonb and applies defaults (mxn, 24h)', () => {
    const c = parseFrontDeskConfig({ ...base, bookingPayment: { amount: 500 } } as never);
    expect(c.bookingPayment).toEqual({ amount: 500, currency: 'mxn', holdHours: 24, deadlineMarginHours: 2 });
    const full = parseFrontDeskConfig({
      ...base,
      bookingPayment: { amount: 350.5, currency: 'MXN', hold_hours: 48, deadline_margin_hours: 0.5, deposit_note: 'se descuenta', statement_suffix: 'DR VALDIVIA' },
    } as never);
    expect(full.bookingPayment).toEqual({ amount: 350.5, currency: 'mxn', holdHours: 48, deadlineMarginHours: 0.5, depositNote: 'se descuenta', statementSuffix: 'DR VALDIVIA' });
  });

  it('malformed → null + a loud log, never a throw (a typo must not kill every turn)', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(parseFrontDeskConfig({ ...base, bookingPayment: { amount: -5 } } as never).bookingPayment).toBeNull();
    expect(parseFrontDeskConfig({ ...base, bookingPayment: { amount: 500, statement_suffix: 'x'.repeat(23) } } as never).bookingPayment).toBeNull();
    expect(parseFrontDeskConfig({ ...base, bookingPayment: 'yes' } as never).bookingPayment).toBeNull();
    expect(spy).toHaveBeenCalledTimes(3);
    spy.mockRestore();
  });

  it('holdAmountCents: per-service deposit wins, cents are rounded, null without the feature', () => {
    const c = parseFrontDeskConfig({ ...base, services: [{ name: 'A', deposit: 199.995 }, { name: 'B' }], bookingPayment: { amount: 500 } } as never);
    expect(holdAmountCents(c, 'A')).toBe(20000);
    expect(holdAmountCents(c, 'B')).toBe(50000);
    expect(holdAmountCents(c, 'unknown')).toBe(50000);
    expect(holdAmountCents(parseFrontDeskConfig(base as never), 'A')).toBeNull();
  });
});
