import { describe, it, expect } from 'vitest';
import {
  usageFromAgentResult,
  usageFromAnthropicResponse,
  usageFromOpenAiResponse,
} from './llm-usage.js';

describe('usageFromAgentResult', () => {
  it('reads the current AI SDK naming', () => {
    const result = { usage: { inputTokens: 1200, outputTokens: 300 } };
    expect(usageFromAgentResult(result)).toEqual({
      inputTokens: 1200,
      outputTokens: 300,
      cachedInputTokens: 0,
    });
  });

  it('reads the legacy v4 naming so an SDK bump cannot zero out cost reports', () => {
    const result = { usage: { promptTokens: 900, completionTokens: 120 } };
    expect(usageFromAgentResult(result)).toEqual({
      inputTokens: 900,
      outputTokens: 120,
      cachedInputTokens: 0,
    });
  });

  it('picks up cached input tokens from inputTokenDetails', () => {
    const result = {
      usage: { inputTokens: 1000, outputTokens: 50, inputTokenDetails: { cacheReadTokens: 800 } },
    };
    expect(usageFromAgentResult(result)).toMatchObject({ inputTokens: 1000, cachedInputTokens: 800 });
  });

  it('clamps cached tokens to the input total (a bad report would make cost go negative)', () => {
    const result = {
      usage: { inputTokens: 100, outputTokens: 10, inputTokenDetails: { cacheReadTokens: 999 } },
    };
    expect(usageFromAgentResult(result)?.cachedInputTokens).toBe(100);
  });

  it('returns null rather than throwing on a missing or empty usage block', () => {
    expect(usageFromAgentResult(undefined)).toBeNull();
    expect(usageFromAgentResult(null)).toBeNull();
    expect(usageFromAgentResult({})).toBeNull();
    expect(usageFromAgentResult({ usage: {} })).toBeNull();
    expect(usageFromAgentResult({ usage: { inputTokens: 0, outputTokens: 0 } })).toBeNull();
  });

  it('ignores garbage values instead of writing them to the ledger', () => {
    const result = { usage: { inputTokens: -5, outputTokens: Number.NaN } };
    expect(usageFromAgentResult(result)).toBeNull();
  });
});

describe('usageFromOpenAiResponse', () => {
  it('reads the REST body shape used by the classify / extract-name helpers', () => {
    const body = {
      usage: { prompt_tokens: 420, completion_tokens: 12, prompt_tokens_details: { cached_tokens: 128 } },
    };
    expect(usageFromOpenAiResponse(body)).toEqual({
      inputTokens: 420,
      outputTokens: 12,
      cachedInputTokens: 128,
    });
  });

  it('defaults cached tokens to 0 when the provider omits the detail block', () => {
    expect(usageFromOpenAiResponse({ usage: { prompt_tokens: 10, completion_tokens: 2 } }))
      .toEqual({ inputTokens: 10, outputTokens: 2, cachedInputTokens: 0 });
  });

  it('returns null on a body with no usage', () => {
    expect(usageFromOpenAiResponse({ choices: [] })).toBeNull();
  });
});

describe('usageFromAnthropicResponse', () => {
  it('folds cache reads into inputTokens so the number means the same as OpenAI"s', () => {
    // Anthropic reports cache reads OUTSIDE input_tokens; left as-is, a cache-heavy
    // tenant would look far cheaper than it is.
    const body = { usage: { input_tokens: 200, output_tokens: 30, cache_read_input_tokens: 800 } };
    expect(usageFromAnthropicResponse(body)).toEqual({
      inputTokens: 1000,
      outputTokens: 30,
      cachedInputTokens: 800,
    });
  });

  it('handles a response with no caching', () => {
    expect(usageFromAnthropicResponse({ usage: { input_tokens: 50, output_tokens: 7 } }))
      .toEqual({ inputTokens: 50, outputTokens: 7, cachedInputTokens: 0 });
  });

  it('returns null on a body with no usage', () => {
    expect(usageFromAnthropicResponse({ content: [] })).toBeNull();
  });
});
