/**
 * Turn reconciliation sweep (durability net).
 *
 * The 8s debounce is a setTimeout in waitUntil; an isolate eviction or a transient
 * model/GHL failure silently drops the turn. This cron-driven sweep finds
 * conversations whose latest message is an unanswered inbound (past the debounce
 * window) and re-runs the agent — turning a permanent silent drop into a recovery
 * within ~1 minute.
 *
 * It re-applies the same reply gates as the webhook (channel / test / keyword) so a
 * turn that was intentionally gated stays silent; only genuinely-dropped turns run.
 * runAgentTurn re-checks isLatestInboundMessage + isBotSuppressed, and the DB claim
 * (FOR UPDATE SKIP LOCKED + cooldown) prevents double-processing under overlap.
 */

import type { Agent } from '@mastra/core/agent';
import { channelEnabled, hasTriggerKeywords, inTestMode, resolveTenant, roleEnabled } from '../core/tenant.js';
import type { Channel } from '../core/types.js';
import { loadUnansweredTurns } from '../db/queries.js';
import type { ParsedInbound } from '../ghl/types.js';
import { FRONT_DESK_ROLE } from '../roles/front-desk/index.js';
import { runAgentTurn } from './webhook-handler.js';

export interface ReconcileResult {
  claimed: number;
  reran: number;
}

export async function runReconciliationSweep(agent: Agent): Promise<ReconcileResult> {
  const turns = await loadUnansweredTurns();
  let reran = 0;

  for (const turn of turns) {
    const tenant = await resolveTenant(turn.ghlLocationId);
    if (!tenant || !roleEnabled(tenant, FRONT_DESK_ROLE)) continue;

    const channel = turn.channel as Channel;

    // Re-apply the webhook's reply gates (read-only — no logging, no side effects).
    if (inTestMode(tenant)) {
      if (!tenant.testContactIds?.includes(turn.ghlContactId)) continue;
    } else if (!channelEnabled(tenant, channel)) {
      continue;
    }
    if (hasTriggerKeywords(tenant) && !turn.botActivated) continue;

    const parsed: ParsedInbound = {
      locationId: turn.ghlLocationId,
      contactId: turn.ghlContactId,
      conversationId: turn.ghlConversationId,
      channel,
      text: turn.content,
      phone: turn.contactPhone ?? undefined,
      messageId: turn.ghlMessageId ?? undefined,
    };

    try {
      console.log(`[reconcile] re-running dropped turn conv=${turn.ghlConversationId}`);
      await runAgentTurn({
        agent,
        conversationId: turn.conversationId,
        messageId: turn.messageId,
        tenant,
        parsed,
        phone: turn.contactPhone,
        debounced: true,
      });
      reran++;
    } catch (err) {
      console.error('[reconcile] rerun failed:', err instanceof Error ? err.message : String(err));
    }
  }

  return { claimed: turns.length, reran };
}
