/**
 * ConversationDO — per-conversation Durable Object (Phase 1: durable, serialized turns).
 *
 * Addressed by our DB conversation id. A DO instance runs single-threaded, so all
 * processing for one conversation is serialized — the double-run / race class disappears
 * by construction. The 15s debounce is a durable Alarm (survives isolate eviction), which
 * replaces the fragile `setTimeout`-in-`waitUntil` and closes the dropped-turn gap.
 *
 * Rollout is flag-gated (DO_TURNS, see webhook-handler.ts): only enabled tenants route here;
 * the reconciliation cron stays on as a safety net until Phase 3. Follow-up scheduling still
 * happens inside runAgentTurn (moves to a DO alarm in Phase 2).
 *
 * See docs/durable-objects-migration.md.
 */

import { DurableObject } from 'cloudflare:workers';
import { runAgentTurn, type ScheduledTurn } from './webhook-handler.js';
import { buildFrontDeskAgent } from '../roles/front-desk/index.js';

const PENDING_KEY = 'pendingTurn';
/** Debounce window — matches the legacy waitUntil path (coalesces a rapid message burst). */
const DEBOUNCE_MS = 15_000;

export interface ConversationDoEnv {
  CONVERSATION_DO: DurableObjectNamespace<ConversationDO>;
  [key: string]: unknown;
}

export class ConversationDO extends DurableObject<ConversationDoEnv> {
  constructor(ctx: DurableObjectState, env: ConversationDoEnv) {
    super(ctx, env);
    // The turn code reads every secret from process.env (see core/env.ts). Mirror the DO's
    // bindings into process.env so getCoreEnv/getGhlEnv/getAiApiKey work inside this isolate
    // regardless of runtime auto-population. Only string values (skip the DO namespace object).
    for (const [k, v] of Object.entries(env)) {
      if (typeof v === 'string') process.env[k] = v;
    }
  }

  /**
   * Buffer a turn and (re)arm the debounce alarm. Rapid messages coalesce: each call
   * overwrites the pending params and resets the alarm to now+15s, so only the latest
   * message's turn runs once the burst settles.
   */
  async scheduleTurn(params: ScheduledTurn): Promise<void> {
    await this.ctx.storage.put(PENDING_KEY, params);
    await this.ctx.storage.setAlarm(Date.now() + DEBOUNCE_MS);
  }

  override async alarm(): Promise<void> {
    const params = await this.ctx.storage.get<ScheduledTurn>(PENDING_KEY);
    if (!params) return;
    await this.ctx.storage.delete(PENDING_KEY);
    try {
      const agent = buildFrontDeskAgent();
      await runAgentTurn({ ...params, agent, debounced: true });
    } catch (err) {
      // Swallow so CF doesn't auto-retry the alarm and risk a double-send (the turn isn't
      // idempotent yet). A genuine drop is still caught by the reconciliation cron.
      console.error('[ConversationDO] turn failed:', err instanceof Error ? err.message : String(err));
    }
  }
}
