/**
 * Resolves the per-request tenant/turn/config that tools need from the Mastra
 * tool execution context (which carries our RequestContext).
 */

import type { TenantContext, TurnContext } from '../../../core/types.js';
import { parseFrontDeskConfig, type FrontDeskConfig } from '../config.js';

/** Minimal shape of the tool execution context we depend on. */
export interface ToolCtxLike {
  requestContext?: { get(key: string): unknown } | undefined;
}

export interface ResolvedAgentContext {
  tenant: TenantContext;
  turn: TurnContext;
  config: FrontDeskConfig;
}

export function resolveAgentContext(ctx: ToolCtxLike): ResolvedAgentContext {
  const rc = ctx.requestContext;
  if (!rc) throw new Error('front-desk tool: missing request context');
  const tenant = rc.get('tenant') as TenantContext | undefined;
  const turn = rc.get('turn') as TurnContext | undefined;
  if (!tenant || !turn) {
    throw new Error('front-desk tool: missing tenant/turn in request context');
  }
  return { tenant, turn, config: parseFrontDeskConfig(tenant.config) };
}
