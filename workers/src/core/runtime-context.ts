/**
 * Per-request context passed into the agent.
 *
 * Mastra resolves dynamic agent instructions/model and tool execution against a
 * `RequestContext`. We inject the resolved tenant, the current turn's GHL ids,
 * and the model + API key (read from the Worker env) so the agent and its tools
 * stay multi-tenant without any module-level state.
 */

import { RequestContext } from '@mastra/core/request-context';
import type { TenantContext, TurnContext } from './types.js';

export interface AgentRequestValues {
  tenant: TenantContext;
  turn: TurnContext;
  /** Model id, e.g. 'claude-sonnet-4-6'. */
  model: string;
  /** Anthropic API key, read from the Worker env at request time. */
  anthropicApiKey: string;
}

export type AgentRequestContext = RequestContext<AgentRequestValues>;

export function buildAgentRequestContext(values: AgentRequestValues): AgentRequestContext {
  const ctx = new RequestContext<AgentRequestValues>();
  ctx.set('tenant', values.tenant);
  ctx.set('turn', values.turn);
  ctx.set('model', values.model);
  ctx.set('anthropicApiKey', values.anthropicApiKey);
  return ctx;
}
