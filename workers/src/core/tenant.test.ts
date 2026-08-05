import { describe, it, expect } from 'vitest';
import { channelEnabled, inTestMode, hasTriggerKeywords, matchVariantKeyword, messageMatchesTrigger, roleEnabled } from './tenant.js';
import type { TenantContext } from './types.js';

function tenant(overrides: Partial<TenantContext> = {}): TenantContext {
  return {
    tenantId: 't1',
    clientId: 'c1',
    ghlLocationId: 'loc1',
    enabledRoles: ['front-desk'],
    enabledChannels: ['facebook'],
    testContactIds: null,
    triggerKeywords: null,
    demoOnKeywords: null,
    demoOffKeywords: null,
    keywordVariants: null,
    awaitingHumanTag: null,
    pendingInfoTag: null,
    demoSessionsEnabled: false,
    metaCapi: null,
    config: {} as TenantContext['config'],
    ...overrides,
  };
}

describe('roleEnabled', () => {
  it('reflects the enabled roles', () => {
    expect(roleEnabled(tenant(), 'front-desk')).toBe(true);
    expect(roleEnabled(tenant(), 'reactivation')).toBe(false);
  });
});

describe('channelEnabled', () => {
  it('is true only for listed channels', () => {
    expect(channelEnabled(tenant({ enabledChannels: ['facebook'] }), 'facebook')).toBe(true);
    expect(channelEnabled(tenant({ enabledChannels: ['facebook'] }), 'whatsapp')).toBe(false);
  });

  it('is false when enabledChannels is null (silent)', () => {
    expect(channelEnabled(tenant({ enabledChannels: null }), 'facebook')).toBe(false);
  });
});

describe('inTestMode', () => {
  it('is true only with a non-empty allowlist', () => {
    expect(inTestMode(tenant({ testContactIds: null }))).toBe(false);
    expect(inTestMode(tenant({ testContactIds: [] }))).toBe(false);
    expect(inTestMode(tenant({ testContactIds: ['c1'] }))).toBe(true);
  });
});

describe('hasTriggerKeywords', () => {
  it('is true only with a non-empty keyword list', () => {
    expect(hasTriggerKeywords(tenant({ triggerKeywords: null }))).toBe(false);
    expect(hasTriggerKeywords(tenant({ triggerKeywords: [] }))).toBe(false);
    expect(hasTriggerKeywords(tenant({ triggerKeywords: ['agente'] }))).toBe(true);
  });
});

describe('messageMatchesTrigger', () => {
  const kw = ['agente'];

  it('matches a whole word, any case/punctuation', () => {
    expect(messageMatchesTrigger('Agente', kw)).toBe(true);
    expect(messageMatchesTrigger('Hola, AGENTE!', kw)).toBe(true);
    expect(messageMatchesTrigger('quiero un agente', kw)).toBe(true);
  });

  it('does NOT match substrings of other words', () => {
    expect(messageMatchesTrigger('es urgente', kw)).toBe(false);
    expect(messageMatchesTrigger('agentes varios', kw)).toBe(false);
  });

  it('matches multi-word phrases', () => {
    expect(messageMatchesTrigger('hola, quiero info ya', ['quiero info'])).toBe(true);
    expect(messageMatchesTrigger('quiero informacion', ['quiero info'])).toBe(false);
  });

  it('returns false when no keyword is present', () => {
    expect(messageMatchesTrigger('hola buenos dias', kw)).toBe(false);
    expect(messageMatchesTrigger('agente', [])).toBe(false);
  });
});

describe('matchVariantKeyword', () => {
  const map = {
    'info': 'general',
    'me interesa promo de laser': 'laser-promo',
    'promo laser': 'laser-promo',
    'quiero saber de sus servicios de depilación': 'depilacion',
  };

  it('returns null when the tenant has no variants', () => {
    expect(matchVariantKeyword(tenant({ keywordVariants: null }), 'info')).toBeNull();
  });

  it('maps a keyword to its variant (n:1 — two keywords, same variant)', () => {
    expect(matchVariantKeyword(tenant({ keywordVariants: map }), 'Hola! Me interesa promo de laser')).toEqual(
      { keyword: 'me interesa promo de laser', variant: 'laser-promo' },
    );
    expect(matchVariantKeyword(tenant({ keywordVariants: map }), 'vi su PROMO LASER')).toEqual(
      { keyword: 'promo laser', variant: 'laser-promo' },
    );
  });

  it('prefers the longest matching keyword when several match', () => {
    // "info" also appears, but the campaign phrase is more specific and wins.
    expect(
      matchVariantKeyword(tenant({ keywordVariants: { info: 'general', 'info de depilación': 'depilacion' } }), 'quiero info de depilación'),
    ).toEqual({ keyword: 'info de depilación', variant: 'depilacion' });
  });

  it('is whole-word and accent/case-insensitive like the trigger gate', () => {
    expect(matchVariantKeyword(tenant({ keywordVariants: map }), 'necesito información')).toBeNull(); // not whole-word "info"
    expect(matchVariantKeyword(tenant({ keywordVariants: map }), 'INFO, por favor')).toEqual(
      { keyword: 'info', variant: 'general' },
    );
  });

  it('ignores entries with empty variant values and returns null when nothing matches', () => {
    expect(matchVariantKeyword(tenant({ keywordVariants: { roto: '  ' } }), 'roto')).toBeNull();
    expect(matchVariantKeyword(tenant({ keywordVariants: map }), 'hola buenas tardes')).toBeNull();
  });
});
