import { describe, it, expect } from 'vitest';
import {
  auxReasoningEffort,
  reasoningProviderOptions,
  supportsEffortNone,
  supportsReasoningEffort,
} from './reasoning.js';
import { DEFAULT_MODEL } from '../roles/front-desk/agent.js';

describe('supportsReasoningEffort', () => {
  it('accepts the gpt-5 family', () => {
    expect(supportsReasoningEffort('gpt-5.6-luna')).toBe(true);
    expect(supportsReasoningEffort('gpt-5-mini')).toBe(true);
  });

  it('rejects models that 400 on the parameter', () => {
    expect(supportsReasoningEffort('gpt-4o-mini')).toBe(false);
    expect(supportsReasoningEffort('claude-sonnet-5')).toBe(false);
  });

  // The non-reasoning variant is inside the gpt-5 name but takes no effort.
  it('rejects the chat variant', () => {
    expect(supportsReasoningEffort('gpt-5-chat-latest')).toBe(false);
  });
});

describe('supportsEffortNone', () => {
  it('needs a minor version — flat gpt-5 rejects none', () => {
    expect(supportsEffortNone('gpt-5.6-luna')).toBe(true);
    expect(supportsEffortNone('gpt-5-mini')).toBe(false);
    expect(supportsEffortNone('gpt-4o-mini')).toBe(false);
  });
});

describe('reasoningProviderOptions', () => {
  it('sends the effort for an OpenAI reasoning model', () => {
    expect(reasoningProviderOptions('openai', 'gpt-5.6-luna', 'high')).toEqual({
      openai: { reasoningEffort: 'high' },
    });
  });

  // Empty = send nothing, so the provider default stays in force.
  it('sends nothing for Anthropic or for a model that would reject it', () => {
    expect(reasoningProviderOptions('anthropic', 'claude-sonnet-5', 'high')).toEqual({});
    expect(reasoningProviderOptions('openai', 'gpt-4o-mini', 'high')).toEqual({});
    expect(reasoningProviderOptions('openai', 'gpt-5-mini', 'none')).toEqual({});
  });
});

describe('auxReasoningEffort', () => {
  it('turns reasoning off where the model allows it', () => {
    expect(auxReasoningEffort('gpt-5.6-luna')).toBe('none');
  });

  // Never falls back to 'minimal': that still runs a reasoning pass, which is what the
  // auxiliary calls' token budget cannot absorb.
  it('omits the parameter everywhere else', () => {
    expect(auxReasoningEffort('gpt-5-mini')).toBeUndefined();
    expect(auxReasoningEffort('gpt-4o-mini')).toBeUndefined();
  });
});

// The platform default and these rules ship together: a default the helpers don't
// recognize would silently run at the provider's effort instead of ours.
describe('the platform default', () => {
  it('takes both a reasoning effort and the none level', () => {
    expect(supportsReasoningEffort(DEFAULT_MODEL)).toBe(true);
    expect(supportsEffortNone(DEFAULT_MODEL)).toBe(true);
  });
});
