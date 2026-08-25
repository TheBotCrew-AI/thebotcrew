/**
 * Auxiliary (non-agent) model calls: the status classifier, the name extractor and the
 * resume gate. They hit the provider REST APIs directly rather than going through
 * Mastra, so their tokens would otherwise be invisible spend — they run on every turn
 * and add up. Shared here so `resume-gate.ts` can use them without importing the
 * webhook handler (which imports it).
 */

import type { AiProvider } from '../core/types.js';
import { usageFromAnthropicResponse, usageFromOpenAiResponse } from '../core/llm-usage.js';
import { auxReasoningEffort } from '../core/reasoning.js';
import { logLlmUsage } from '../db/queries.js';

/**
 * Output budget for the auxiliary OpenAI calls. Each returns a one-line JSON object, so
 * the value looks absurdly generous — it isn't:
 *
 *  · `max_tokens` is REJECTED outright by the gpt-5 family ("Unsupported parameter …
 *    use max_completion_tokens"). That 400 silently killed BOTH calls from the day the
 *    platform default moved to gpt-5-mini: they are fire-and-forget, so nothing surfaced
 *    beyond a log line. `llm_usage` proves it — not one `classify` or `extract-name` row
 *    had ever been written. The classifier never ran (conversations stayed `active`, so
 *    follow-ups kept chasing leads who were done) and the contact-name backstop never ran
 *    (page-form leads kept their business name).
 *  · `max_completion_tokens` counts REASONING tokens too, so the old value of 32 returns
 *    HTTP 200 with an empty string (`finish_reason: "length"`) — a silent failure that
 *    looks healthier than the 400 it replaced. 300 leaves room for the reasoning pass.
 *
 * The budget stays at 300 because it is the fallback: `reasoning_effort: 'none'` is sent
 * only where the model accepts it (`auxReasoningEffort`), and any model that doesn't
 * still spends the budget on hidden reasoning. Anthropic keeps `max_tokens: 32` — that
 * API's required parameter, and it does not spend it on reasoning.
 */
export const AUX_MAX_COMPLETION_TOKENS = 300;

/**
 * Everything an auxiliary model call needs: which key to use, and where to bill the
 * tokens.
 */
export interface AuxLlmCall {
  clientId: string;
  ghlConversationId: string;
  provider: AiProvider;
  apiKey: string;
  model: string;
  /** 'platform' or the tenant's ai_key_ref — recorded on the usage row. */
  keySource: string;
}

/** Record an auxiliary call's tokens. Never throws; usage must not break a turn. */
export function recordAuxUsage(llm: AuxLlmCall, callKind: string, body: unknown): void {
  const usage = llm.provider === 'anthropic'
    ? usageFromAnthropicResponse(body)
    : usageFromOpenAiResponse(body);
  if (!usage) return;
  void logLlmUsage({
    clientId: llm.clientId,
    ghlConversationId: llm.ghlConversationId,
    callKind,
    provider: llm.provider,
    model: llm.model,
    usage,
    keySource: llm.keySource,
  });
}

/**
 * One prompt in, the model's raw text out, tokens billed under `callKind`. Throws on a
 * non-2xx response — the caller decides what a failure means for its flow.
 */
export async function auxJsonCompletion(
  prompt: string,
  llm: AuxLlmCall,
  callKind: string,
  // The classifier/extractor/resume-gate answers fit in the default; the info-gap
  // extraction (a JSON list per conversation) needs room.
  maxCompletionTokens: number = AUX_MAX_COMPLETION_TOKENS,
): Promise<string> {
  if (llm.provider === 'anthropic') {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': llm.apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: llm.model,
        max_tokens: maxCompletionTokens === AUX_MAX_COMPLETION_TOKENS ? 32 : maxCompletionTokens,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!res.ok) throw new Error(`anthropic ${callKind} ${res.status}`);
    const data = await res.json() as { content: { text: string }[] };
    recordAuxUsage(llm, callKind, data);
    return data.content[0]?.text ?? '';
  }

  const auxEffort = auxReasoningEffort(llm.model);
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${llm.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: llm.model,
      max_completion_tokens: maxCompletionTokens,
      ...(auxEffort && { reasoning_effort: auxEffort }),
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`openai ${callKind} ${res.status}`);
  const data = await res.json() as { choices: { message: { content: string } }[] };
  recordAuxUsage(llm, callKind, data);
  return data.choices[0]?.message?.content ?? '';
}
