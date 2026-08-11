/**
 * Reasoning-effort capability rules for OpenAI models.
 *
 * `tenant_config.ai_model` may name any model, so effort is never assumed to be
 * accepted — every helper here is a capability check on the model id. Callers pick
 * the level; this module only decides whether it can be sent at all.
 */

import type { AiProvider } from './types.js';

export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

/**
 * Whether the model takes a reasoning effort at all. On a model outside this family
 * the parameter is rejected with a 400, which on a fire-and-forget call dies silently.
 */
export function supportsReasoningEffort(model: string): boolean {
  return model.startsWith('gpt-5') && !model.startsWith('gpt-5-chat');
}

/**
 * Whether the model accepts the `none` level specifically — flat `gpt-5` rejects it
 * while still accepting `minimal`. Matched on the minor version so later releases are
 * recognized without a code change.
 */
export function supportsEffortNone(model: string): boolean {
  const minor = /^gpt-5\.(\d+)/.exec(model);
  return minor !== null && Number(minor[1]) >= 1;
}

/**
 * Provider options for a Mastra agent's `defaultOptions`. Empty means "send nothing",
 * leaving the provider's own default effort in force: Anthropic drives thinking with a
 * different parameter, and an unsupported effort must not reach the wire.
 */
export function reasoningProviderOptions(
  provider: AiProvider,
  model: string,
  effort: ReasoningEffort,
): Record<string, Record<string, string>> {
  if (provider !== 'openai') return {};
  if (!supportsReasoningEffort(model)) return {};
  if (effort === 'none' && !supportsEffortNone(model)) return {};
  return { openai: { reasoningEffort: effort } };
}

/**
 * Effort for the auxiliary Chat Completions calls, or undefined for the caller to spread
 * away. `minimal` is not used as a fallback: it still runs a reasoning pass, which is the
 * thing those calls cannot afford (see AUX_MAX_COMPLETION_TOKENS in worker/webhook-handler.ts).
 */
export function auxReasoningEffort(model: string): 'none' | undefined {
  return supportsEffortNone(model) ? 'none' : undefined;
}
