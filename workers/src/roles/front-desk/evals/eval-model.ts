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

/**
 * `EVAL_MODEL=gpt-5-mini pnpm eval` — reproduce a case on the model that produced it.
 *
 * An incident is usually reported on a model the platform has since moved off (the
 * "(sí/no)" messages were `gpt-5-mini`; the default became `gpt-5.6-luna` the same
 * week). Without this, "the new case passes" can mean the fix works OR that the new
 * model never had the bug — and those are very different facts. Unset in normal runs,
 * so `pnpm eval` still gates the model that actually serves tenants.
 */
export const evalModel = process.env.EVAL_MODEL ?? (openaiKey ? DEFAULT_MODEL : ANTHROPIC_EVAL_MODEL);
/** Empty when neither key is set — live suites self-skip on this. */
export const evalApiKey = openaiKey ?? anthropicKey ?? '';
