/**
 * GHL outbound webhook handler — human agent takeover.
 *
 * GHL fires this webhook on every message delivered to a contact, including
 * our own bot replies (source: 'api'). We filter to source: 'app' (human agent
 * sent via the GHL UI) and ignore everything else.
 *
 * Flow:
 *   1. Verify signature.
 *   2. Parse: return early if not a human-sent outbound message.
 *   3. Secondary bot-echo guards: by GHL message ID, then by content+recency
 *      (catches our own echo when we couldn't capture its id).
 *   4. Resolve tenant.
 *   5. Resolve (or lazily create) the human_agents row for this GHL user.
 *   6. Log message to our store (sender_type='human_agent').
 *   7. Start/refresh the 5-min human-active timer.
 *   8. Cancel any pending follow-ups (human is in the conversation).
 */

import { resolveTenant } from '../core/tenant.js';
import type { TenantContext } from '../core/types.js';
import {
  cancelFollowUps,
  findHumanAgentByGhlId,
  isBotMessageById,
  isRecentBotEcho,
  logMessage,
  setHumanActive,
  upsertHumanAgent,
} from '../db/queries.js';
import { GhlClient } from '../ghl/client.js';
import type { GhlOutboundWebhook } from '../ghl/types.js';
import { parseOutboundWebhook } from '../ghl/webhook.js';
import type { WebhookResult } from './webhook-handler.js';

export async function handleOutboundWebhook(
  payload: GhlOutboundWebhook,
): Promise<WebhookResult> {
  // Signature already verified at the route handler (raw body, before parse).
  const parsed = parseOutboundWebhook(payload);
  if (!parsed) {
    return { status: 200, body: { ignored: 'not a human agent outbound message' } };
  }

  // Secondary guard: if this GHL message ID is already stored as a bot message,
  // it's an echo of our own reply that slipped past the source==='api' filter.
  if (await isBotMessageById(parsed.messageId)) {
    return { status: 200, body: { ignored: 'bot echo (confirmed by DB)' } };
  }

  // Content backstop: an echo of our own send whose GHL id we couldn't capture comes
  // back as source:'app' with a NEW message id, so the id guard above misses it. Match
  // it by exact content + recency so it isn't mislabeled as a human takeover.
  if (await isRecentBotEcho(parsed.conversationId, parsed.text)) {
    return { status: 200, body: { ignored: 'bot echo (matched by content)' } };
  }

  const tenant = await resolveTenant(parsed.locationId);
  if (!tenant) {
    return { status: 200, body: { ignored: 'unknown or inactive tenant', locationId: parsed.locationId } };
  }

  const ghl = new GhlClient(tenant.tenantId);
  const humanAgentId = await resolveHumanAgent(tenant, parsed.ghlUserId, ghl);

  const { conversationId, messageId } = await logMessage({
    p_ghl_conversation_id: parsed.conversationId,
    p_client_id: tenant.clientId,
    p_channel: parsed.channel,
    p_ghl_contact_id: parsed.contactId,
    p_contact_phone: parsed.phone ?? null,
    p_direction: 'outbound',
    p_sender_type: 'human_agent',
    p_content: parsed.text,
    p_agent_role: null,
    p_human_agent_id: humanAgentId,
    p_model: null,
    p_sent_at: parsed.sentAt,
    p_ghl_message_id: parsed.messageId,
  });

  if (!messageId) {
    // Duplicate message deduplicated by ghl_message_id unique constraint.
    return { status: 200, body: { ignored: 'duplicate', ghlMessageId: parsed.messageId } };
  }

  // These must be awaited — fire-and-forget gets killed when the Worker response is sent
  // on Cloudflare (no waitUntil available here).
  try {
    await setHumanActive(parsed.conversationId);
  } catch (e) {
    console.error('[outbound] setHumanActive failed:', e instanceof Error ? e.message : String(e));
  }
  if (conversationId) {
    try {
      await cancelFollowUps(conversationId);
    } catch (e) {
      console.error('[outbound] cancelFollowUps failed:', e instanceof Error ? e.message : String(e));
    }
  }

  console.log(
    `[outbound] human message conv=${parsed.conversationId} agent=${humanAgentId ?? 'unknown'} timer=5min`,
  );
  return { status: 200, body: { logged: true, conversationId } };
}

/**
 * Return the human_agents UUID for this GHL userId, creating the row if needed.
 * Fast path: already in our DB (ghl_user_id unique index — O(1) lookup).
 * Slow path: fetch from GHL Users API, then upsert.
 */
async function resolveHumanAgent(
  tenant: TenantContext,
  ghlUserId: string,
  ghl: GhlClient,
): Promise<string | null> {
  const existing = await findHumanAgentByGhlId(ghlUserId);
  if (existing) return existing;

  const userInfo = await ghl.getUser(ghlUserId);
  if (!userInfo) {
    console.warn(`[outbound] GHL user ${ghlUserId} not found — storing with placeholder name`);
  }

  return upsertHumanAgent({
    p_client_id: tenant.clientId,
    p_ghl_user_id: ghlUserId,
    p_name: userInfo?.name ?? `GHL User ${ghlUserId}`,
    p_email: userInfo?.email ?? null,
  });
}
