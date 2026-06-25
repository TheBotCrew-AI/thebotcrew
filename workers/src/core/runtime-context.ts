/**
 * Per-request context passed into the agent.
 *
 * Mastra resolves dynamic agent instructions/model and tool execution against a
 * `RequestContext`. We inject the resolved tenant, the current turn's GHL ids,
 * and the model + API key (read from the Worker env) so the agent and its tools
 * stay multi-tenant without any module-level state.
 */

import { RequestContext } from '@mastra/core/request-context';
import type { AiProvider, TenantContext, TurnContext } from './types.js';

export interface AgentRequestValues {
  tenant: TenantContext;
  turn: TurnContext;
  provider: AiProvider;
  model: string;
  llmApiKey: string;
  /** Set for reactivation agent runs; undefined for front-desk runs. */
  reactivationAngle?: string;
}

export type AgentRequestContext = RequestContext<AgentRequestValues>;

export function buildAgentRequestContext(values: AgentRequestValues): AgentRequestContext {
  const ctx = new RequestContext<AgentRequestValues>();
  ctx.set('tenant', values.tenant);
  ctx.set('turn', values.turn);
  ctx.set('provider', values.provider);
  ctx.set('model', values.model);
  ctx.set('llmApiKey', values.llmApiKey);
  if (values.reactivationAngle !== undefined) {
    ctx.set('reactivationAngle', values.reactivationAngle);
  }
  return ctx;
}
