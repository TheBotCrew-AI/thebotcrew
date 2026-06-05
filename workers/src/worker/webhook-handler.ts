/**
 * GHL inbound webhook orchestration.
 *
 * Flow: verify → parse → resolve tenant → log inbound (our store) → gate on
 * role/handoff → load history (our store) → run agent → log outbound → deliver
 * via GHL. History always comes from our DB, never from GHL.
 */

import type { Agent } from '@mastra/core/agent';
import { getCoreEnv, getGhlEnv } from '../core/env.js';
import { resolveTenant, roleEnabled } from '../core/tenant.js';
import { buildAgentRequestContext } from '../core/runtime-context.js';
import type { ConversationMessage, TurnContext } from '../core/types.js';
import { isHandedOff, loadRecentMessages, logMessage } from '../db/queries.js';
import { GhlClient } from '../ghl/client.js';
import { parseInboundWebhook, verifyWebhook } from '../ghl/webhook.js';
import type { GhlInboundWebhook } from '../ghl/types.js';
import { DEFAULT_MODEL, FRONT_DESK_ROLE } from '../roles/front-desk/index.js';

export interface WebhookResult {
  status: 200 | 400 | 401 | 500;
  body: Record<string, unknown>;
}

type ChatMessage = { role: 'user'; content: string } | { role: 'assistant'; content: string };

/** Map our stored turns into the model's user/assistant view. */
function toModelMessages(history: ConversationMessage[]): ChatMessage[] {
  return history.map((m): ChatMessage =>
    m.senderType === 'lead'
      ? { role: 'user', content: m.content }
      : { role: 'assistant', content: m.content },
  );
}

export async function handleInboundWebhook(
  payload: GhlInboundWebhook,
  headers: Headers,
  agent: Agent,
): Promise<WebhookResult> {
  const ghlEnv = getGhlEnv();
  if (!verifyWebhook(headers, ghlEnv.webhookSecret)) {
    return { status: 401, body: { error: 'invalid signature' } };
  }

  const parsed = parseInboundWebhook(payload);
  if (!parsed) {
    return { status: 200, body: { ignored: 'unparseable or non-message payload' } };
  }

  const tenant = await resolveTenant(parsed.locationId);
  if (!tenant) {
    return { status: 200, body: { ignored: 'unknown or inactive tenant', locationId: parsed.locationId } };
  }

  // 1) Persist the inbound turn (upserts the conversation, returns our id).
  const { conversationId } = await logMessage({
    p_ghl_conversation_id: parsed.conversationId,
    p_client_id: tenant.clientId,
    p_channel: parsed.channel,
    p_ghl_contact_id: parsed.contactId,
    p_contact_phone: parsed.phone ?? null,
    p_direction: 'inbound',
    p_sender_type: 'lead',
    p_content: parsed.text,
    p_agent_role: null,
    p_human_agent_id: null,
    p_model: null,
    p_sent_at: null,
  });

  // 2) Gate: role disabled or a human owns the thread → AI stays silent.
  if (!roleEnabled(tenant, FRONT_DESK_ROLE)) {
    return { status: 200, body: { ignored: 'front-desk role disabled for tenant', conversationId } };
  }
  if (await isHandedOff(parsed.conversationId)) {
    return { status: 200, body: { ignored: 'conversation handed off to human', conversationId } };
  }

  // 3) Rebuild history from OUR store (includes the inbound just logged).
  const history = await loadRecentMessages(conversationId);
  const messages = toModelMessages(history);

  // 4) Run the agent with per-request tenant context.
  const turn: TurnContext = {
    ghlConversationId: parsed.conversationId,
    ghlContactId: parsed.contactId,
    contactPhone: parsed.phone,
    channel: parsed.channel,
  };
  const requestContext = buildAgentRequestContext({
    tenant,
    turn,
    model: DEFAULT_MODEL,
    anthropicApiKey: getCoreEnv().ANTHROPIC_API_KEY,
  });

  const result = await agent.generate(messages, { requestContext });
  const reply = result.text;

  // 5) Persist the outbound turn with attribution (which AI role + model).
  await logMessage({
    p_ghl_conversation_id: parsed.conversationId,
    p_client_id: tenant.clientId,
    p_channel: parsed.channel,
    p_ghl_contact_id: parsed.contactId,
    p_contact_phone: parsed.phone ?? null,
    p_direction: 'outbound',
    p_sender_type: 'bot',
    p_content: reply,
    p_agent_role: FRONT_DESK_ROLE,
    p_human_agent_id: null,
    p_model: DEFAULT_MODEL,
    p_sent_at: null,
  });

  // 6) Deliver via GHL (transport; stubbed until endpoints are wired).
  await new GhlClient(tenant.tenantId).sendMessage(parsed.conversationId, reply);

  return { status: 200, body: { replied: true, conversationId } };
}
