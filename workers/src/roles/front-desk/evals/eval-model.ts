/**
 * Which model the live eval cases run against.
 *
 * Provider and model must be chosen TOGETHER. This used to be picked inline as
 * `provider = ANTHROPIC_API_KEY ? 'anthropic' : 'openai'` while the model stayed
 * `DEFAULT_MODEL` — so with an Anthropic key present every live case sent
 * `gpt-5-mini` to Anthropic and died on the first call. Keeping the pairing in
 * one place is the fix.
 *
 * OpenAI wins when both keys are present: `DEFAULT_MODEL` is the platform
 * default, so the golden cases gate the model that actually serves tenants.
 */

import type { AiProvider } from '../../../core/types.js';
import { DEFAULT_MODEL } from '../agent.js';

/** Anthropic counterpart to DEFAULT_MODEL, used only when no OpenAI key is set. */
const ANTHROPIC_EVAL_MODEL = 'claude-sonnet-5';

const openaiKey = process.env.OPENAI_API_KEY;
const anthropicKey = process.env.ANTHROPIC_API_KEY;

export const evalProvider: AiProvider = openaiKey ? 'openai' : 'anthropic';
export const evalModel = openaiKey ? DEFAULT_MODEL : ANTHROPIC_EVAL_MODEL;
/** Empty when neither key is set — live suites self-skip on this. */
export const evalApiKey = openaiKey ?? anthropicKey ?? '';
