/**
 * sendSystemMessage — deliver ONE deterministic bot message outside a turn.
 *
 * The paid-confirmation flow (0062) speaks from a webhook (payment landed) and
 * from a cron (the hold expired): no inbound to answer, no model call, just a
 * sentence the runtime already decided on. Same discipline as a nudge
 * (followup-runner's deliverNudge): log the outbound row first — the message
 * store is what we tell clients is the truth — then send via GHL, then mark
 * delivered. A send failure leaves the row `pending` for the delivery-retry cron.
 *
 * Respects the human takeover: while a person is active on the thread, or the
 * conversation is handed off, the message is NOT sent (the state change it
 * announces still happened; the person sees the tag). Returned as 'suppressed'
 * so the caller can log why the lead heard nothing.
 */

import type { Channel, TenantContext } from '../core/types.js';
import { isBotSuppressed, logMessage, markDelivered, setGhlMessageId, updateConversationContact } from '../db/queries.js';
import { GhlClient } from '../ghl/client.js';

/** `messages.agent_role` for these sends: not front-desk (no model ran), not a nudge. */
export const SYSTEM_MESSAGE_ROLE = 'system';

export type SystemSendResult = 'sent' | 'suppressed' | 'failed';

export async function sendSystemMessage(args: {
  tenant: TenantContext;
  ghlConversationId: string;
  ghlContactId: string;
  channel: string;
  contactPhone: string | null;
  text: string;
  tag: string;
}): Promise<SystemSendResult> {
  const { tenant } = args;
  try {
    if (await isBotSuppressed(args.ghlConversationId)) {
      console.log(`[${args.tag}] suppressed (human active / handed off) conv=${args.ghlConversationId}`);
      return 'suppressed';
    }
  } catch (err) {
    // Failing toward silence would hide a paid confirmation from the lead; toward noise it
    // costs one message on a thread a person is working. The check is cheap and rarely
    // errors — proceed, but say so.
    console.error(`[${args.tag}] isBotSuppressed failed, sending anyway:`, err instanceof Error ? err.message : String(err));
  }

  let outboundMessageId: string | null = null;
  try {
    ({ messageId: outboundMessageId } = await logMessage({
      p_ghl_conversation_id: args.ghlConversationId,
      p_client_id: tenant.clientId,
      p_channel: args.channel,
      p_ghl_contact_id: args.ghlContactId,
      p_contact_phone: args.contactPhone,
      p_direction: 'outbound',
      p_sender_type: 'bot',
      p_content: args.text,
      p_agent_role: SYSTEM_MESSAGE_ROLE,
      p_human_agent_id: null,
      p_model: null,
      p_sent_at: null,
    }));
  } catch (err) {
    console.error(`[${args.tag}] logMessage failed:`, err instanceof Error ? err.message : String(err));
  }

  const ghl = new GhlClient(tenant.tenantId);
  let ghlMessageId: string | null = null;
  try {
    const sent = await ghl.sendMessage({
      contactId: args.ghlContactId,
      channel: args.channel as Channel,
      text: args.text,
      phone: args.contactPhone ?? undefined,
      conversationId: args.ghlConversationId,
    });
    ghlMessageId = sent.ghlMessageId;
    if (sent.resolvedContactId && sent.resolvedContactId !== args.ghlContactId) {
      updateConversationContact(args.ghlConversationId, sent.resolvedContactId).catch((e: unknown) =>
        console.error(`[${args.tag}] updateConversationContact failed:`, e instanceof Error ? e.message : String(e)),
      );
    }
  } catch (err) {
    console.error(`[${args.tag}] sendMessage failed:`, err instanceof Error ? err.message : String(err));
    return 'failed';
  }

  // AWAITED, not fire-and-forget: this runs from a webhook route (no waitUntil) and from
  // the cron's waitUntil, and in both the isolate can be torn down the moment the awaited
  // chain resolves. Seen live 2026-09-20: two sent messages stayed `pending` because these
  // writes were detached, and a pending row is exactly what the delivery-retry cron
  // resends — a double "recibimos tu pago" to the lead.
  if (ghlMessageId && outboundMessageId) {
    await Promise.all([
      setGhlMessageId(outboundMessageId, ghlMessageId).catch((e: unknown) =>
        console.error(`[${args.tag}] setGhlMessageId failed:`, e instanceof Error ? e.message : String(e)),
      ),
      markDelivered(outboundMessageId).catch((e: unknown) =>
        console.error(`[${args.tag}] markDelivered failed:`, e instanceof Error ? e.message : String(e)),
      ),
    ]);
  }
  return 'sent';
}
