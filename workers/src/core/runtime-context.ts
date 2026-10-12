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
import type { LeadStage } from './lead-stage.js';

export interface AgentRequestValues {
  tenant: TenantContext;
  turn: TurnContext;
  provider: AiProvider;
  model: string;
  llmApiKey: string;
  /** Unused angle pool passed to reactivation runs (hybrid selection); undefined for front-desk. */
  reactivationCandidates?: string[];
  /** Set when the conversation has been through a demo, so a reactivation nudge doesn't
   *  chase the lead about the roleplay (its fake appointment, the lead's own services). */
  demoContext?: { businessName?: string; booked?: boolean };
  /** Which reactivation round this nudge runs under (0049). Round 1+ softens the
   *  prompt; the final touch of the final round becomes the farewell message. */
  reactivationRound?: { round: number; isFinalTouch: boolean; reentryKeyword: string };
  /** The lead's stage + what this nudge is for (0068). Only set when the tenant has a
   *  playbook; absent = the pre-0068 prompt, byte-identical. */
  stageContext?: StageContext;
}

export interface StageContext {
  stage: LeadStage;
  /** The nudge's job at this stage (tenant's text or the platform default). */
  objective: string;
  /** The configured service the lead asked about, with the ONLY facts the nudge may state. */
  service: { name: string; description: string | null } | null;
}

export type AgentRequestContext = RequestContext<AgentRequestValues>;

export function buildAgentRequestContext(values: AgentRequestValues): AgentRequestContext {
  const ctx = new RequestContext<AgentRequestValues>();
  ctx.set('tenant', values.tenant);
  ctx.set('turn', values.turn);
  ctx.set('provider', values.provider);
  ctx.set('model', values.model);
  ctx.set('llmApiKey', values.llmApiKey);
  if (values.reactivationCandidates !== undefined) {
    ctx.set('reactivationCandidates', values.reactivationCandidates);
  }
  if (values.demoContext !== undefined) {
    ctx.set('demoContext', values.demoContext);
  }
  if (values.reactivationRound !== undefined) {
    ctx.set('reactivationRound', values.reactivationRound);
  }
  if (values.stageContext !== undefined) {
    ctx.set('stageContext', values.stageContext);
  }
  return ctx;
}
