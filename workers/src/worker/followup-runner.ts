/**
 * Follow-up runner — called by the 1-minute cron via /internal/run-followups.
 *
 * For each due follow-up:
 *   1. Load tenant config (abort if unknown/inactive).
 *   2. Find the tier config to get the angle.
 *   3. Generate a reactivation message using the reactivation agent.
 *   4. Log outbound + deliver via GHL.
 *   5. Mark follow-up sent.
 *   6. Schedule the next tier, or set conversation to standby when tiers are exhausted.
 */

import type { Agent } from '@mastra/core/agent';
import { getAiApiKey } from '../core/env.js';
import { loadTenantConfig } from '../db/queries.js';
import {
  cancelFollowUps,
  loadDueFollowUps,
  loadSentAngleIndexes,
  logMessage,
  markDelivered,
  markFollowUpFailed,
  markFollowUpSent,
  scheduleFollowUp,
  setGhlMessageId,
  updateConversationStatus,
  updateConversationContact,
  loadRecentMessages,
} from '../db/queries.js';
import { parseAngleSelection } from '../roles/reactivation/angle-select.js';
import { buildAgentRequestContext } from '../core/runtime-context.js';
import type { AiProvider, Channel } from '../core/types.js';
import type { DueFollowUp } from '../db/types.js';
import { GhlClient } from '../ghl/client.js';
import { REACTIVATION_ROLE } from '../roles/reactivation/index.js';
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from '../roles/front-desk/index.js';

export interface FollowUpRunResult {
  processed: number;
  failed: number;
  skipped: number;
}

type ChatMessage = { role: 'user'; content: string } | { role: 'assistant'; content: string };

function toModelMessages(
  history: Awaited<ReturnType<typeof loadRecentMessages>>,
): ChatMessage[] {
  return history.map((m): ChatMessage =>
    m.senderType === 'lead'
      ? { role: 'user', content: m.content }
      : { role: 'assistant', content: m.content },
  );
}

async function processOne(
  followUp: DueFollowUp,
  reactivationAgent: Agent,
): Promise<'ok' | 'skip' | 'fail'> {
  const tenant = await loadTenantConfig(followUp.ghlLocationId);
  if (!tenant) {
    console.warn(`[followup] unknown or inactive tenant for location=${followUp.ghlLocationId}`);
    return 'skip';
  }

  // followUp.tier is the 1-based position within the current cadence cycle.
  const cadence = tenant.config.followUpCadence ?? [];
  const position = followUp.tier;
  if (position < 1 || position > cadence.length) {
    console.warn(`[followup] cadence position ${position} out of range (len=${cadence.length}) tenant=${tenant.tenantId}`);
    return 'skip';
  }

  // Hybrid angle selection: offer only the pool angles not yet SENT on this
  // conversation, so angles never repeat even as the cadence cycle resets. An empty
  // pool (all used) → the agent free-forms a fresh nudge (chosenAngleIndex stays null).
  const anglePool = tenant.config.followUpAngles ?? [];
  const usedIndexes = await loadSentAngleIndexes(followUp.conversationId);
  const remaining = anglePool
    .map((text, index) => ({ text, index }))
    .filter((a) => !usedIndexes.includes(a.index));

  const provider = (tenant.config.provider ?? DEFAULT_PROVIDER) as AiProvider;
  const model = tenant.config.model ?? DEFAULT_MODEL;
  const turn = {
    ghlConversationId: followUp.ghlConversationId,
    ghlContactId: followUp.ghlContactId,
    contactPhone: followUp.contactPhone ?? undefined,
    channel: followUp.channel as Channel,
  };

  const requestContext = buildAgentRequestContext({
    tenant,
    turn,
    provider,
    model,
    llmApiKey: getAiApiKey(provider),
    reactivationCandidates: remaining.map((a) => a.text),
  });

  const history = await loadRecentMessages(followUp.conversationId);
  const messages = toModelMessages(history);

  let reply: string;
  let chosenAngleIndex: number | null = null;
  try {
    const result = await reactivationAgent.generate(messages, { requestContext, maxSteps: 3 });
    const selection = parseAngleSelection(result.text, remaining.length);
    reply = selection.message;
    const picked = selection.angleChoice != null
      ? remaining[selection.angleChoice - 1]
      : remaining[0]; // no valid tag but angles remain → consume the first unused one
    if (picked) chosenAngleIndex = picked.index;
  } catch (err) {
    console.error(
      `[followup] agent generate failed followUpId=${followUp.followUpId}:`,
      err instanceof Error ? err.message : String(err),
    );
    return 'fail';
  }

  let outboundMessageId: string | null = null;
  try {
    ({ messageId: outboundMessageId } = await logMessage({
      p_ghl_conversation_id: followUp.ghlConversationId,
      p_client_id: tenant.clientId,
      p_channel: followUp.channel,
      p_ghl_contact_id: followUp.ghlContactId,
      p_contact_phone: followUp.contactPhone,
      p_direction: 'outbound',
      p_sender_type: 'bot',
      p_content: reply,
      p_agent_role: REACTIVATION_ROLE,
      p_human_agent_id: null,
      p_model: model,
      p_sent_at: null,
    }));
  } catch (err) {
    console.error('[followup] logMessage failed:', err instanceof Error ? err.message : String(err));
  }

  const ghl = new GhlClient(tenant.tenantId);
  let ghlMessageId: string | null = null;
  try {
    const sent = await ghl.sendMessage({
      contactId: followUp.ghlContactId,
      channel: followUp.channel as Channel,
      text: reply,
      phone: followUp.contactPhone ?? undefined,
      conversationId: followUp.ghlConversationId,
    });
    ghlMessageId = sent.ghlMessageId;
    // Recovered a merged-away contact: persist the survivor so future sends skip recovery.
    if (sent.resolvedContactId && sent.resolvedContactId !== followUp.ghlContactId) {
      updateConversationContact(followUp.ghlConversationId, sent.resolvedContactId).catch((e: unknown) =>
        console.error('[followup] updateConversationContact failed:', e instanceof Error ? e.message : String(e)),
      );
    }
  } catch (err) {
    console.error('[followup] sendMessage failed:', err instanceof Error ? err.message : String(err));
  }

  if (ghlMessageId && outboundMessageId) {
    setGhlMessageId(outboundMessageId, ghlMessageId).catch((e: unknown) => {
      console.error('[followup] setGhlMessageId failed:', e instanceof Error ? e.message : String(e));
    });
    markDelivered(outboundMessageId).catch((e: unknown) => {
      console.error('[followup] markDelivered failed:', e instanceof Error ? e.message : String(e));
    });
  }

  await markFollowUpSent(followUp.followUpId, chosenAngleIndex);

  // Advance the cadence cycle: schedule the next attempt, or stop (standby) when the
  // cycle is exhausted with no reply — the "freno". The angle cursor persists across
  // cycles via angle_index, so a reset cycle keeps advancing to fresh angles.
  const nextPosition = position + 1;
  const nextDelay = cadence[nextPosition - 1];
  if (nextDelay !== undefined) {
    await scheduleFollowUp(followUp.conversationId, nextPosition, nextDelay, tenant.config.timezone, tenant.config.quietHours);
  } else {
    await updateConversationStatus(followUp.ghlConversationId, 'standby');
  }

  return 'ok';
}

export async function runPendingFollowUps(
  reactivationAgent: Agent,
): Promise<FollowUpRunResult> {
  const due = await loadDueFollowUps(20);
  if (due.length === 0) return { processed: 0, failed: 0, skipped: 0 };

  console.log(`[followup] processing ${due.length} due follow-up(s)`);

  let processed = 0;
  let failed = 0;
  let skipped = 0;

  for (const followUp of due) {
    try {
      const outcome = await processOne(followUp, reactivationAgent);
      if (outcome === 'ok') processed++;
      else if (outcome === 'skip') skipped++;
      else {
        await markFollowUpFailed(followUp.followUpId).catch(console.error);
        failed++;
      }
    } catch (err) {
      console.error(
        `[followup] unhandled error followUpId=${followUp.followUpId}:`,
        err instanceof Error ? err.message : String(err),
      );
      await markFollowUpFailed(followUp.followUpId).catch(console.error);
      failed++;
    }
  }

  return { processed, failed, skipped };
}
