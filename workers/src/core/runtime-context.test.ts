import { describe, it, expect } from 'vitest';
import type { TenantContext, TurnContext } from './types.js';
import { buildAgentRequestContext } from './runtime-context.js';

const base = {
  tenant: { tenantId: 't1' } as TenantContext,
  turn: { ghlContactId: 'c1' } as TurnContext,
  provider: 'openai' as const,
  model: 'gpt-5-mini',
  llmApiKey: 'key',
};

describe('buildAgentRequestContext', () => {
  it('exposes the core request values', () => {
    const ctx = buildAgentRequestContext(base);
    expect(ctx.get('tenant')).toBe(base.tenant);
    expect(ctx.get('turn')).toBe(base.turn);
    expect(ctx.get('provider')).toBe('openai');
    expect(ctx.get('model')).toBe('gpt-5-mini');
    expect(ctx.get('llmApiKey')).toBe('key');
  });

  it('only sets reactivationCandidates when provided', () => {
    expect(buildAgentRequestContext(base).get('reactivationCandidates')).toBeUndefined();
    const withCands = buildAgentRequestContext({ ...base, reactivationCandidates: ['a', 'b'] });
    expect(withCands.get('reactivationCandidates')).toEqual(['a', 'b']);
  });
});
