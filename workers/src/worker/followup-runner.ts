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
import { resolveAiApiKey } from '../core/env.js';
import { usageFromAgentResult } from '../core/llm-usage.js';
import { loadTenantConfig } from '../db/queries.js';
import {
  cancelFollowUps,
  commitFollowUpSend,
  countSentDemoReminders,
  endDemoSession,
  getActiveDemoSession,
  getConversationPersona,
  getFollowUpStatus,
  getLatestDemoSession,
  loadDueFollowUps,
  loadSentAngleIndexes,
  logBotEvent,
  logLlmUsage,
  logMessage,
  markDelivered,
  markFollowUpFailed,
  markFollowUpSent,
  scheduleFollowUp,
  setActiveRole,
  setGhlMessageId,
  updateConversationStatus,
  updateConversationContact,
  loadRecentMessages,
} from '../db/queries.js';
import { parseAngleSelection, resolveAnglePool } from '../roles/reactivation/angle-select.js';
import { buildAgentRequestContext } from '../core/runtime-context.js';
import { cadenceForRound, isFinalRound, REENTRY_KEYWORD, totalRounds } from '../core/reactivation-rounds.js';
import type { AiProvider, Channel, TenantContext } from '../core/types.js';
import { DEMO_REMINDER_CADENCE, DEMO_REMINDER_ROLE } from '../core/types.js';
import type { DueFollowUp } from '../db/types.js';
import { findUpcomingAppointment } from '../db/upcoming-appointment.js';
import { GhlClient } from '../ghl/client.js';
import { demoEndTag, REACTIVATION_EXHAUSTED_TAG } from '../ghl/tags.js';
import { REACTIVATION_ROLE } from '../roles/reactivation/index.js';
import { buildDemoReminder } from '../roles/front-desk/prompt.js';
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

/**
 * Drop a claimed follow-up because the lead is no longer where we left them.
 * Marked cancelled (not failed) — nothing went wrong, the nudge simply stopped
 * being the right thing to say. Leaving it 'processing' would strand the row.
 */
async function abortFollowUp(
  followUp: DueFollowUp,
  tenant: TenantContext,
  reason: string,
): Promise<'skip'> {
  console.log(`[followup] aborted followUpId=${followUp.followUpId} reason=${reason}`);
  await cancelFollowUps(followUp.conversationId).catch((e: unknown) =>
    console.error('[followup] abort cancel failed:', e instanceof Error ? e.message : String(e)),
  );
  await logBotEvent(tenant.clientId, followUp.ghlConversationId, 'followup_aborted', {
    followUpId: followUp.followUpId,
    kind: followUp.kind,
    tier: followUp.tier,
    reason,
  });
  return 'skip';
}

/**
 * Log + deliver a nudge, in that order, and only AFTER the commit gate has been
 * won — logging first (as this used to) would leave a phantom outbound row on
 * every abort, and the message store is what we tell clients is the truth.
 * Returns the outbound message id so the caller can mark it delivered.
 */
async function deliverNudge(
  followUp: DueFollowUp,
  tenant: TenantContext,
  text: string,
  agentRole: string,
  model: string | null,
): Promise<void> {
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
      p_content: text,
      p_agent_role: agentRole,
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
      text,
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
}

/**
 * The demo ladder: three fixed, out-of-character reminders that a demo session is
 * still open, sent while the lead is quiet mid-roleplay.
 *
 * Deliberately never touches the reactivation agent. That agent loads the full
 * history under the tenant's normal config and would answer from inside the
 * roleplay — the exact failure this ladder exists to avoid. No model call, no
 * angle pool, no tokens: the text is a template and the only variable is the
 * tenant's configured exit keyword.
 *
 * The last rung closes the session. Until now a lead who walked away mid-demo was
 * unreachable forever: expiry is only evaluated on the next inbound, so with no
 * next inbound the conversation sat in active_role='demo' permanently. Rung 3
 * hands them to the closer, which puts them back on the 44-angle ladder.
 */
async function processDemoReminder(
  followUp: DueFollowUp,
  tenant: TenantContext,
  activeRole: string | null,
  reactivationRound: number,
): Promise<'ok' | 'skip' | 'fail'> {
  // The demo may have ended (booked, exhausted, or the lead typed the exit word)
  // between scheduling and now. A reminder about a closed demo is nonsense.
  if (activeRole !== 'demo') {
    return abortFollowUp(followUp, tenant, 'demo_no_longer_active');
  }

  // Rung = how many have LANDED, not what was scheduled — see countSentDemoReminders.
  const rung = (await countSentDemoReminders(followUp.conversationId)) + 1;
  if (rung > DEMO_REMINDER_CADENCE.length) {
    return abortFollowUp(followUp, tenant, 'demo_ladder_exhausted');
  }

  // No pre-flight here, unlike the cadence path: there is no generation to save, so
  // the atomic gate alone does the job in one round trip.
  if (!(await commitFollowUpSend(followUp.followUpId, followUp.lastInboundMessageId))) {
    return abortFollowUp(followUp, tenant, 'lead_replied');
  }

  const text = buildDemoReminder(rung, tenant.demoOffKeywords?.[0]);
  await deliverNudge(followUp, tenant, text, DEMO_REMINDER_ROLE, null);
  await markFollowUpSent(followUp.followUpId, null);
  await logBotEvent(tenant.clientId, followUp.ghlConversationId, 'demo_reminder_sent', {
    rung,
    followUpId: followUp.followUpId,
  });

  const nextDelay = DEMO_REMINDER_CADENCE[rung];
  if (nextDelay !== undefined) {
    await scheduleFollowUp(
      followUp.conversationId, rung + 1, nextDelay,
      tenant.config.timezone, tenant.config.quietHours, 'demo', 0,
    );
    return 'ok';
  }

  // Last rung: close the demo and hand the lead to the closer, so the normal
  // cadence takes it from here. Best-effort throughout — a lead stuck in 'demo'
  // is the bug we are fixing, so none of this may throw the turn away.
  try {
    const session = await getActiveDemoSession(followUp.ghlConversationId);
    if (session) {
      await endDemoSession(session.id, 'expired');
      await logBotEvent(tenant.clientId, followUp.ghlConversationId, 'demo_session_ended', {
        sessionId: session.id,
        reason: 'expired',
        via: 'demo_reminder_ladder',
      });
    }
    // The role flip is the load-bearing part — it is what un-strands the lead — so
    // it runs before the cosmetic GHL tag and is never behind it.
    await setActiveRole(followUp.ghlConversationId, 'closer');
    console.log(`[followup] demo ladder exhausted → closer conv=${followUp.ghlConversationId}`);
    new GhlClient(tenant.tenantId).addContactTags(followUp.ghlContactId, [demoEndTag('expired')])
      .catch((e: unknown) =>
        console.error('[demo-session] end tag failed (non-blocking):', e instanceof Error ? e.message : String(e)),
      );
  } catch (e) {
    console.error('[followup] demo close failed:', e instanceof Error ? e.message : String(e));
  }

  // Restart the reactivation ladder under the closer. The angle cursor is
  // untouched by demo reminders (they never carry an angle_index), so the lead
  // still has the whole pool ahead of them. Round-aware (0049): the restart runs
  // the lead's CURRENT round, and a lead past the last round restarts nothing.
  if (reactivationRound < totalRounds(tenant.config)) {
    const firstDelay = cadenceForRound(tenant.config, reactivationRound)[0];
    if (firstDelay !== undefined) {
      await scheduleFollowUp(
        followUp.conversationId, 1, firstDelay,
        tenant.config.timezone, tenant.config.quietHours, 'cadence', reactivationRound,
      );
    }
  }
  return 'ok';
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

  // Persona drives both ladders: which one this row belongs to, and (below) the
  // clean history start + demo handoff context for the reactivation agent.
  let promptVariant: string | null = null;
  let activeRole: string | null = null;
  let roleStartedAt: string | null = null;
  let reactivationRound = 0;
  try {
    ({ promptVariant, activeRole, roleStartedAt, reactivationRound } = await getConversationPersona(followUp.conversationId));
  } catch (e) {
    console.error('[followup] persona read failed (using tenant angle pool):', e instanceof Error ? e.message : String(e));
  }

  if (followUp.kind === 'demo') {
    return processDemoReminder(followUp, tenant, activeRole, reactivationRound);
  }

  // A cadence nudge that finds the conversation back inside a demo would arrive
  // mid-roleplay — the demo ladder owns this conversation until it ends.
  if (activeRole === 'demo') {
    return abortFollowUp(followUp, tenant, 'conversation_in_demo');
  }

  // followUp.tier is the 1-based position within the current cadence cycle, and the
  // cycle's shape comes from the round the row was SCHEDULED under (0049) — not from
  // whatever the conversation's counter says now — so a mid-cycle config or counter
  // change can't re-shape a ladder that's already running.
  const cadence = cadenceForRound(tenant.config, followUp.round);
  const position = followUp.tier;
  if (position < 1 || position > cadence.length) {
    console.warn(`[followup] cadence position ${position} out of range (len=${cadence.length}, round=${followUp.round}) tenant=${tenant.tenantId}`);
    return 'skip';
  }
  const finalTouch = isFinalRound(tenant.config, followUp.round) && position === cadence.length;

  // Pre-flight before the expensive part: if the lead's inbound already cancelled
  // this row, bail out now rather than after paying for a generation.
  if ((await getFollowUpStatus(followUp.followUpId)) !== 'processing') {
    return abortFollowUp(followUp, tenant, 'lead_replied');
  }

  // Help mode (0049): a lead holding an upcoming appointment is a customer, not a
  // pursuit target. GHL is always consulted when the store says no, because the
  // appointment this must catch is exactly the one our store can never see — the
  // next session a package customer booked with STAFF at the clinic, or a nudge
  // armed moments before the booking landed. Fails open (GHL errors read as "no
  // appointment"): worst case is one nudge to a booked customer, never silence.
  try {
    const appt = await findUpcomingAppointment(
      tenant.clientId, followUp.ghlContactId, new GhlClient(tenant.tenantId), Date.now(),
      { alwaysCheckGhl: true },
    );
    if (appt) {
      return abortFollowUp(followUp, tenant, 'has_upcoming_appointment');
    }
  } catch (e) {
    console.error('[followup] upcoming-appointment check failed (fails open):', e instanceof Error ? e.message : String(e));
  }

  // Hybrid angle selection: offer only the pool angles not yet SENT on this
  // conversation, so angles never repeat even as the cadence cycle resets. An empty
  // pool (all used) → the agent free-forms a fresh nudge (chosenAngleIndex stays null).
  // Campaign-aware (0040): a conversation pinned to a prompt variant whose config
  // carries followUpAngles nudges from THAT pool — "¿sigues interesada en la promo?"
  // — falling back to the tenant pool on any missing/malformed config or read error.
  // The farewell (final touch of the final round) bypasses the pool entirely: it is
  // a goodbye, not an angle, and letting it fall through the "no valid tag → consume
  // remaining[0]" fallback below would silently burn an angle on a message that
  // deliberately isn't one.
  let remaining: Array<{ text: string; index: number }> = [];
  if (!finalTouch) {
    const { pool: anglePool } = resolveAnglePool(
      tenant.config.promptVariants,
      promptVariant,
      tenant.config.followUpAngles ?? [],
    );
    const usedIndexes = await loadSentAngleIndexes(followUp.conversationId);
    remaining = anglePool
      .map((text, index) => ({ text, index }))
      .filter((a) => !usedIndexes.includes(a.index));
  }

  const provider = (tenant.config.provider ?? DEFAULT_PROVIDER) as AiProvider;
  const model = tenant.config.model ?? DEFAULT_MODEL;
  const turn = {
    ghlConversationId: followUp.ghlConversationId,
    ghlContactId: followUp.ghlContactId,
    contactPhone: followUp.contactPhone ?? undefined,
    channel: followUp.channel as Channel,
  };

  // Same per-tenant key as a live turn: follow-ups are real spend and must be
  // attributed to the same client, not to the platform key.
  const aiKey = resolveAiApiKey(provider, tenant.config.aiKeyRef);
  if (aiKey.fellBack) {
    console.error(
      `[ai-key] tenant=${tenant.tenantId} ai_key_ref="${tenant.config.aiKeyRef}" has no Worker secret — using the platform key`,
    );
    await logBotEvent(tenant.clientId, followUp.ghlConversationId, 'ai_key_fallback', {
      keyRef: tenant.config.aiKeyRef,
      provider,
      stage: 'followup',
    });
  }

  // A conversation that went through a demo needs two corrections here, because this
  // runner is otherwise persona-blind (it loads full history with the tenant's normal
  // config). Without them the nudge is written from the ROLEPLAY — chasing the lead
  // about the fake appointment they booked while pretending to be their own customer.
  let demoContext: { businessName?: string; booked?: boolean } | undefined;
  if (activeRole === 'closer') {
    try {
      const last = await getLatestDemoSession(followUp.ghlConversationId);
      if (last) {
        const lead = last.leadData as { businessName?: string };
        demoContext = { businessName: lead.businessName, booked: last.booked };
      }
    } catch (e) {
      console.error('[followup] demo context read failed (non-blocking):', e instanceof Error ? e.message : String(e));
    }
  }

  const requestContext = buildAgentRequestContext({
    tenant,
    turn,
    provider,
    model,
    llmApiKey: aiKey.apiKey,
    reactivationCandidates: remaining.map((a) => a.text),
    demoContext,
    reactivationRound: { round: followUp.round, isFinalTouch: finalTouch, reentryKeyword: REENTRY_KEYWORD },
  });

  // Same clean-start rule as a live turn: read history from when the CURRENT persona
  // took over, so a post-demo nudge sees the closer's conversation, not the roleplay.
  const history = await loadRecentMessages(followUp.conversationId, 20, roleStartedAt ?? undefined);
  const messages = toModelMessages(history);

  let reply: string;
  let chosenAngleIndex: number | null = null;
  try {
    const result = await reactivationAgent.generate(messages, { requestContext, maxSteps: 3 });
    const usage = usageFromAgentResult(result);
    if (usage) {
      void logLlmUsage({
        clientId: tenant.clientId,
        ghlConversationId: followUp.ghlConversationId,
        callKind: REACTIVATION_ROLE,
        provider,
        model,
        usage,
        keySource: aiKey.source,
      });
    }
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

  // THE GATE. Generation took anywhere from a few seconds to half a minute, and the
  // lead may have answered inside it — on 2026-07-31 one did, 9 seconds before this
  // point, and got chased about a question she had just answered. Atomic: only one
  // of {the lead's cancel, this send} can win, and the loser stops here.
  if (!(await commitFollowUpSend(followUp.followUpId, followUp.lastInboundMessageId))) {
    return abortFollowUp(followUp, tenant, 'lead_replied');
  }

  await deliverNudge(followUp, tenant, reply, REACTIVATION_ROLE, model);
  await markFollowUpSent(followUp.followUpId, chosenAngleIndex);

  // Advance the cadence cycle: schedule the next attempt, or stop (standby) when the
  // cycle is exhausted with no reply — the "freno". The angle cursor persists across
  // cycles via angle_index, so a reset cycle keeps advancing to fresh angles. The next
  // rung keeps the ROW's round: the cycle finishes under the shape it started with.
  const nextPosition = position + 1;
  const nextDelay = cadence[nextPosition - 1];
  if (nextDelay !== undefined) {
    await scheduleFollowUp(
      followUp.conversationId, nextPosition, nextDelay,
      tenant.config.timezone, tenant.config.quietHours, 'cadence', followUp.round,
    );
  } else {
    await updateConversationStatus(followUp.ghlConversationId, 'standby');
    if (isFinalRound(tenant.config, followUp.round)) {
      // The LAST round just exhausted unanswered: this lead got the farewell and will
      // never be pursued again (the arming gate reads reactivation_round, which the
      // mark-sent above pushed past totalRounds). Record it + surface it in GHL.
      await logBotEvent(tenant.clientId, followUp.ghlConversationId, 'reactivation_exhausted', {
        round: followUp.round,
        followUpId: followUp.followUpId,
      });
      new GhlClient(tenant.tenantId)
        .addContactTags(followUp.ghlContactId, [REACTIVATION_EXHAUSTED_TAG])
        .catch((e: unknown) =>
          console.error('[followup] exhausted tag failed (non-blocking):', e instanceof Error ? e.message : String(e)),
        );
    }
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
