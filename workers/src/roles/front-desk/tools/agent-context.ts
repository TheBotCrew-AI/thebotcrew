/**
 * Resolves the per-request tenant/turn/config that tools need from the Mastra
 * tool execution context (which carries our RequestContext).
 */

import type { TenantContext, TurnContext } from '../../../core/types.js';
import { frameTimeZone } from '../../../core/lead-timezone.js';
import { parseFrontDeskConfig, type FrontDeskConfig } from '../config.js';

/** Minimal shape of the tool execution context we depend on. */
export interface ToolCtxLike {
  requestContext?: { get(key: string): unknown } | undefined;
}

export interface ResolvedAgentContext {
  tenant: TenantContext;
  turn: TurnContext;
  config: FrontDeskConfig;
  /**
   * The zone every time label and every wall-clock match uses this turn — the
   * lead's when the tenant opted in and we know it, otherwise the tenant's. The
   * demo is pinned to the tenant's: the roleplay is a walk-in clinic, and its
   * simulated slots are generated in that zone.
   */
  frameTz: string;
}

export function resolveAgentContext(ctx: ToolCtxLike): ResolvedAgentContext {
  const rc = ctx.requestContext;
  if (!rc) throw new Error('front-desk tool: missing request context');
  const tenant = rc.get('tenant') as TenantContext | undefined;
  const turn = rc.get('turn') as TurnContext | undefined;
  if (!tenant || !turn) {
    throw new Error('front-desk tool: missing tenant/turn in request context');
  }
  const config = parseFrontDeskConfig(tenant.config);
  const frameTz = turn.activeRole === 'demo' ? config.timezone : frameTimeZone(config, turn);
  return { tenant, turn, config, frameTz };
}
