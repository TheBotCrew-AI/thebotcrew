import { describe, it, expect } from 'vitest';
import { channelEnabled, inTestMode, hasTriggerKeywords, messageMatchesTrigger, roleEnabled } from './tenant.js';
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
