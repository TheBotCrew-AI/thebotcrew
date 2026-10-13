/**
 * Reasoning-effort capability rules for OpenAI models.
 *
 * `tenant_config.ai_model` may name any model, so effort is never assumed to be
 * accepted — every helper here is a capability check on the model id. Callers pick
 * the level; this module only decides whether it can be sent at all.
 *
 * The rules are written as EXCEPTIONS: the handful of older models known to reject the
 * parameter are listed, and any other `gpt-*` id is treated as a current reasoning
 * model that takes every level including `none`. Swapping the platform default to a
 * newer release is therefore a one-constant change (plus a `model_pricing` row); the
 * list below only grows when a model is found to reject the parameter.
 */

import type { AiProvider } from './types.js';

export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** Pre-reasoning families: the parameter is a 400 on every one of them. */
const NO_REASONING_PREFIXES = ['gpt-3', 'gpt-4', 'gpt-5-chat'];

/** Flat gpt-5 (`gpt-5`, `gpt-5-mini`, `gpt-5-nano`): takes an effort but rejects `none`. */
const NO_NONE_LEVEL = /^gpt-5(-|$)/;

/**
 * Whether the model takes a reasoning effort at all. On a model outside the OpenAI
 * reasoning families the parameter is rejected with a 400, which on a fire-and-forget
 * call dies silently.
 */
export function supportsReasoningEffort(model: string): boolean {
  if (!model.startsWith('gpt-')) return false;
  return !NO_REASONING_PREFIXES.some((p) => model.startsWith(p));
}

/**
 * Whether the model accepts the `none` level specifically — flat `gpt-5` rejects it
 * while still accepting `minimal`; everything from gpt-5.1 on takes it.
 */
export function supportsEffortNone(model: string): boolean {
  return supportsReasoningEffort(model) && !NO_NONE_LEVEL.test(model);
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
