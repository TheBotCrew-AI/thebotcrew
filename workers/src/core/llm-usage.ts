/**
 * Token accounting — normalize "how many tokens did that call burn" across the
 * three shapes we get them in, so spend can be attributed per tenant.
 *
 * Why normalize at all: the platform makes model calls through two different
 * paths. The agents go through Mastra/AI SDK (`result.usage`), while the two
 * cheap helpers in the webhook handler (status classify, name extract) hit the
 * provider REST APIs directly and get the provider's own body shape. Both feed
 * the same `llm_usage` table, so both get funnelled through here.
 *
 * Everything is defensive and returns null rather than throwing: usage is
 * observability, and a missing/renamed field must never break a turn. The AI SDK
 * has already renamed these once (v4 `promptTokens` → v5+ `inputTokens`), which
 * is exactly why both spellings are accepted.
 */

/** Normalized token counts for one model call. */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  /** Cached input tokens, billed at a lower rate. 0 when the provider reports none. */
  cachedInputTokens: number;
}

function toCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

/**
 * Read usage off a Mastra / AI SDK generate result.
 *
 * Accepts both the current `inputTokens`/`outputTokens` naming and the older
 * `promptTokens`/`completionTokens`, so an SDK bump can't silently zero out
 * every cost report. Returns null when the result carries no usage at all.
 */
export function usageFromAgentResult(result: unknown): TokenUsage | null {
  const usage = (result as { usage?: Record<string, unknown> } | null | undefined)?.usage;
  if (!usage || typeof usage !== 'object') return null;

  const input = toCount(usage.inputTokens) || toCount(usage.promptTokens);
  const output = toCount(usage.outputTokens) || toCount(usage.completionTokens);
  const details = usage.inputTokenDetails as { cacheReadTokens?: unknown } | undefined;
  const cached = toCount(details?.cacheReadTokens) || toCount(usage.cachedInputTokens);

  if (input === 0 && output === 0) return null;
  // Cached is a SUBSET of input; a provider reporting more cached than total input
  // would make the cost view subtract into negative territory. Clamp it.
  return { inputTokens: input, outputTokens: output, cachedInputTokens: Math.min(cached, input) };
}

/** Read usage off a raw OpenAI chat-completions response body. */
export function usageFromOpenAiResponse(body: unknown): TokenUsage | null {
  const usage = (body as { usage?: Record<string, unknown> } | null | undefined)?.usage;
  if (!usage || typeof usage !== 'object') return null;

  const input = toCount(usage.prompt_tokens);
  const output = toCount(usage.completion_tokens);
  const details = usage.prompt_tokens_details as { cached_tokens?: unknown } | undefined;
  const cached = toCount(details?.cached_tokens);

  if (input === 0 && output === 0) return null;
  return { inputTokens: input, outputTokens: output, cachedInputTokens: Math.min(cached, input) };
}

/** Read usage off a raw Anthropic messages response body. */
export function usageFromAnthropicResponse(body: unknown): TokenUsage | null {
  const usage = (body as { usage?: Record<string, unknown> } | null | undefined)?.usage;
  if (!usage || typeof usage !== 'object') return null;

  const output = toCount(usage.output_tokens);
  const cached = toCount(usage.cache_read_input_tokens);
  // Anthropic reports cache reads OUTSIDE input_tokens, unlike OpenAI. Fold them in
  // so `inputTokens` means the same thing in both — otherwise cached-heavy tenants
  // would look artificially cheap.
  const input = toCount(usage.input_tokens) + cached;

  if (input === 0 && output === 0) return null;
  return { inputTokens: input, outputTokens: output, cachedInputTokens: cached };
}
