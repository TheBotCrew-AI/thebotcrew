/**
 * ConversationDO — per-conversation Durable Object (Phase 1: durable, serialized turns).
 *
 * Addressed by our DB conversation id. A DO instance runs single-threaded, so all
 * processing for one conversation is serialized — the double-run / race class disappears
 * by construction. The 15s debounce is a durable Alarm (survives isolate eviction), which
 * replaces the fragile `setTimeout`-in-`waitUntil` and closes the dropped-turn gap.
 *
 * The same alarm also carries the pause-resume: a turn suppressed by the sliding human
 * pause is stored back and the alarm re-armed for the pause expiry, so a lead who wrote
 * while a human had the thread is re-checked once the human is gone (see resume-gate.ts).
 *
 * Rollout is flag-gated (DO_TURNS, see webhook-handler.ts): only enabled tenants route here.
 * The old reconciliation cron was removed in Phase 3 (the DO's durable Alarm makes it redundant);
 * a `waitUntil` fall-through remains only for the rare case scheduleTurn throws. Follow-up
 * scheduling still happens inside runAgentTurn (would move to a DO alarm in the optional Phase 2).
 *
 * See docs/durable-objects-migration.md.
 */

import { DurableObject } from 'cloudflare:workers';
import { runAgentTurn, type ScheduledTurn } from './webhook-handler.js';
import { buildFrontDeskAgent } from '../roles/front-desk/index.js';
import { logBotEvent } from '../db/queries.js';

const PENDING_KEY = 'pendingTurn';
/** Debounce window — matches the legacy waitUntil path (coalesces a rapid message burst). */
const DEBOUNCE_MS = 15_000;
/** Slack after the pause expiry, so the resumed run reads the pause as over, not as
 *  expiring this same millisecond. */
const RESUME_GRACE_MS = 5_000;

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
      const result = await runAgentTurn({ ...params, agent, debounced: true });
      const resumeAt = typeof result.body.resumeAt === 'string' ? Date.parse(result.body.resumeAt) : NaN;
      if (Number.isFinite(resumeAt)) await this.scheduleResume(params, resumeAt);
    } catch (err) {
      // Swallow so CF doesn't auto-retry the alarm and risk a double-send (the turn isn't
      // idempotent yet). The Alarm already fired durably, so this is a genuine terminal failure
      // (logged) rather than a silent drop — the reconciliation net that used to catch it is gone.
      console.error('[ConversationDO] turn failed:', err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * The turn was suppressed by the sliding human pause: put it back and re-arm the alarm
   * for the pause expiry, flagged `resumed` so the resume gate runs. A lead message that
   * arrived meanwhile has already stored its own pending turn (the DO delivers other
   * requests while runAgentTurn awaits the network) — that newer turn supersedes this one,
   * so leave it and its 15s alarm alone.
   */
  private async scheduleResume(params: ScheduledTurn, pauseEndsAt: number): Promise<void> {
    const current = await this.ctx.storage.get<ScheduledTurn>(PENDING_KEY);
    if (current && current.messageId !== params.messageId) return;
    const at = Math.max(pauseEndsAt, Date.now()) + RESUME_GRACE_MS;
    await this.ctx.storage.put(PENDING_KEY, { ...params, resumed: true });
    await this.ctx.storage.setAlarm(at);
    await logBotEvent(params.tenant.clientId, params.parsed.conversationId, 'turn_scheduled', {
      via: 'pause-resume',
      resumeAt: new Date(at).toISOString(),
    });
  }
}
