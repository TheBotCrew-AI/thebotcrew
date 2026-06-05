/**
 * Front-desk Mastra agent.
 *
 * One agent serves every tenant: instructions and model are resolved per request
 * from the injected RequestContext (the idiomatic Mastra multi-tenant pattern).
 * The Anthropic key is read from the Worker env (via request context) rather than
 * implicit process env, so it works on Cloudflare Workers.
 */

import { Agent } from '@mastra/core/agent';
import { createAnthropic } from '@ai-sdk/anthropic';
import type { TenantContext } from '../../core/types.js';
import { buildFrontDeskInstructions } from './prompt.js';
import { parseFrontDeskConfig } from './config.js';
import { lookupFaqTool } from './tools/lookup-faq.js';
import { getAvailabilityTool } from './tools/get-availability.js';
import { bookAppointmentTool } from './tools/book-appointment.js';

export const FRONT_DESK_ROLE = 'front-desk';

/** Production default. Overridable per tenant later via config/request context. */
export const DEFAULT_MODEL = 'claude-sonnet-4-6';

export function buildFrontDeskAgent(): Agent {
  return new Agent({
    id: 'front-desk',
    name: 'Front Desk',
    description: 'Recepcionista virtual multi-tenant: califica leads, responde FAQ y agenda citas.',
    instructions: ({ requestContext }) => {
      const tenant = requestContext.get('tenant') as TenantContext;
      return buildFrontDeskInstructions(parseFrontDeskConfig(tenant.config));
    },
    model: ({ requestContext }) => {
      const apiKey = requestContext.get('anthropicApiKey') as string;
      const modelId = requestContext.get('model') as string;
      return createAnthropic({ apiKey })(modelId);
    },
    tools: {
      lookupFaq: lookupFaqTool,
      getAvailability: getAvailabilityTool,
      bookAppointment: bookAppointmentTool,
    },
  });
}
