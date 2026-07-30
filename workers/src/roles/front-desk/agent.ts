/**
 * Front-desk Mastra agent.
 *
 * One agent serves every tenant: instructions and model are resolved per request
 * from the injected RequestContext (the idiomatic Mastra multi-tenant pattern).
 * The Anthropic key is read from the Worker env (via request context) rather than
 * implicit process env, so it works on Cloudflare Workers.
 */

import { Agent } from '@mastra/core/agent';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import type { AiProvider, TenantContext, TurnContext } from '../../core/types.js';
import { buildFrontDeskInstructions } from './prompt.js';
import { parseFrontDeskConfig } from './config.js';
import { lookupFaqTool } from './tools/lookup-faq.js';
import { getAvailabilityTool } from './tools/get-availability.js';
import { bookAppointmentTool } from './tools/book-appointment.js';
import { rescheduleAppointmentTool } from './tools/reschedule-appointment.js';
import { cancelAppointmentTool } from './tools/cancel-appointment.js';
import { lookupAppointmentTool } from './tools/lookup-appointment.js';
import { updateConversationStatusTool } from './tools/update-conversation-status.js';
import { updateContactNameTool } from './tools/update-contact-name.js';
import { flagAwaitingHumanTool } from './tools/flag-awaiting-human.js';

export const FRONT_DESK_ROLE = 'front-desk';

export const DEFAULT_PROVIDER: AiProvider = 'openai';
export const DEFAULT_MODEL = 'gpt-5-mini';

export function buildFrontDeskAgent(): Agent {
  return new Agent({
    id: 'front-desk',
    name: 'Front Desk',
    description: 'Recepcionista virtual multi-tenant: califica leads, responde FAQ y agenda citas.',
    instructions: ({ requestContext }) => {
      const tenant = requestContext.get('tenant') as TenantContext;
      const turn = requestContext.get('turn') as TurnContext | undefined;
      const config = parseFrontDeskConfig(tenant.config);
      const nowLocal = new Date()
        .toLocaleString('sv-SE', { timeZone: config.timezone })
        .replace(' ', 'T');
      return buildFrontDeskInstructions(
        config,
        nowLocal,
        turn?.contactPhone,
        turn?.activeRole,
        turn?.contactName,
        turn?.activeAppointment,
        turn?.promptVariant,
      );
    },
    model: ({ requestContext }) => {
      const provider = requestContext.get('provider') as AiProvider;
      const apiKey = requestContext.get('llmApiKey') as string;
      const modelId = requestContext.get('model') as string;
      if (provider === 'anthropic') return createAnthropic({ apiKey })(modelId);
      return createOpenAI({ apiKey })(modelId);
    },
    tools: {
      lookupFaq: lookupFaqTool,
      getAvailability: getAvailabilityTool,
      bookAppointment: bookAppointmentTool,
      lookupAppointment: lookupAppointmentTool,
      rescheduleAppointment: rescheduleAppointmentTool,
      cancelAppointment: cancelAppointmentTool,
      updateConversationStatus: updateConversationStatusTool,
      updateContactName: updateContactNameTool,
      flagAwaitingHuman: flagAwaitingHumanTool,
    },
  });
}
