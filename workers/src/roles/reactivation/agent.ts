import { Agent } from '@mastra/core/agent';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import type { AiProvider, TenantContext } from '../../core/types.js';
import { reasoningProviderOptions, type ReasoningEffort } from '../../core/reasoning.js';
import { buildReactivationInstructions, type RoundContext } from './prompt.js';
import { parseReactivationConfig } from './config.js';

export const REACTIVATION_ROLE = 'reactivation';

/**
 * A nudge is one short line picked from a supplied angle list — no tools, no branching.
 * Kept low so the follow-up cron doesn't pay agent-grade reasoning per silent lead.
 */
const REASONING_EFFORT: ReasoningEffort = 'low';

export function buildReactivationAgent(): Agent {
  return new Agent({
    id: 'reactivation',
    name: 'Reactivation',
    description: 'Sends short follow-up messages to silent leads to bait a response.',
    instructions: ({ requestContext }) => {
      const tenant = requestContext.get('tenant') as TenantContext;
      const candidates = (requestContext.get('reactivationCandidates') as string[] | undefined) ?? [];
      const demo = requestContext.get('demoContext') as { businessName?: string; booked?: boolean } | undefined;
      const roundCtx = requestContext.get('reactivationRound') as RoundContext | undefined;
      const config = parseReactivationConfig(tenant.config);
      return buildReactivationInstructions(config.businessName, config.tone, candidates, demo, roundCtx);
    },
    model: ({ requestContext }) => {
      const provider = requestContext.get('provider') as AiProvider;
      const apiKey = requestContext.get('llmApiKey') as string;
      const modelId = requestContext.get('model') as string;
      if (provider === 'anthropic') return createAnthropic({ apiKey })(modelId);
      return createOpenAI({ apiKey })(modelId);
    },
    defaultOptions: ({ requestContext }) => ({
      providerOptions: reasoningProviderOptions(
        requestContext.get('provider') as AiProvider,
        requestContext.get('model') as string,
        REASONING_EFFORT,
      ),
    }),
    // No tools — reactivation only sends plain text.
    tools: {},
  });
}
