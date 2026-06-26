/**
 * GHL inbound webhook orchestration.
 *
 * Flow: verify → parse → resolve tenant → log inbound (our store) →
 * schedule agent run with debounce → return 200 immediately.
 *
 * Debounce: each inbound message schedules the agent run after DEBOUNCE_MS.
 * If another message arrives before the timer fires, it updates the
 * `last_inbound_message_id` pointer on the conversation. Only the handler
 * whose messageId still matches that pointer proceeds — the rest skip.
 * Because all messages are already in the DB by the time any handler wakes up,
 * loadRecentMessages() naturally returns the full accumulated history.
 */

import type { Agent } from '@mastra/core/agent';
import { getAiApiKey } from '../core/env.js';
import { channelEnabled, hasTriggerKeywords, inTestMode, messageMatchesTrigger, resolveTenant, roleEnabled } from '../core/tenant.js';
import { buildAgentRequestContext } from '../core/runtime-context.js';
import type { AiProvider, ConversationMessage, ConversationStatus, TenantContext, TurnContext } from '../core/types.js';
import {
  cancelFollowUps,
  botActivation,
  isBotSuppressed,
  isHumanActive,
  isLatestInboundMessage,
  loadRecentMessages,
  logBotEvent,
  logError,
  logMessage,
  markDelivered,
  reactivateConversation,
  scheduleFollowUp,
  setGhlMessageId,
  updateConversationStatus,
} from '../db/queries.js';
import { GhlClient } from '../ghl/client.js';
import { parseInboundWebhook } from '../ghl/webhook.js';
import { STATUS_TAGS } from '../ghl/tags.js';
import type { GhlInboundWebhook, ParsedInbound } from '../ghl/types.js';
import { DEFAULT_MODEL, DEFAULT_PROVIDER, FRONT_DESK_ROLE } from '../roles/front-desk/index.js';

/**
 * Milliseconds to wait after the last inbound message before running the agent.
 * Coalesces a burst of rapid messages into one reply. 15s tolerates natural
 * typing pauses (8s split multi-message turns into separate replies).
 */
const DEBOUNCE_MS = 15_000;

export interface WebhookResult {
  status: 200 | 400 | 401 | 500;
  body: Record<string, unknown>;
}

interface ExecutionCtx {
  waitUntil(promise: Promise<unknown>): void;
}

export interface AgentRunParams {
  agent: Agent;
  conversationId: string;
  messageId: string;
  tenant: TenantContext;
  parsed: ParsedInbound;
  phone: string | null | undefined;
  /** When true, check the debounce gate before proceeding. */
  debounced: boolean;
}

type ChatMessage = { role: 'user'; content: string } | { role: 'assistant'; content: string };

/** One send attempt; returns the GHL message ID on success, null on failure. */
async function trySend(ghl: GhlClient, params: Parameters<GhlClient['sendMessage']>[0]): Promise<string | null> {
  try {
    const { ghlMessageId } = await ghl.sendMessage(params);
    return ghlMessageId || null;
  } catch {
    return null;
  }
}

/**
 * Attempt delivery with one inline retry after 1.5s.
 * Returns the GHL message ID on success, null if both attempts fail.
 * If both fail, the DB row stays delivery_status='pending' and the cron picks it up.
 */
async function sendWithRetry(ghl: GhlClient, params: Parameters<GhlClient['sendMessage']>[0]): Promise<string | null> {
  const id = await trySend(ghl, params);
  if (id) return id;
  await new Promise<void>((r) => setTimeout(r, 1500));
  return trySend(ghl, params);
}

/**
 * Split a reply on blank-line paragraph breaks so it goes out as separate, more
 * human-feeling messages. Caps at MAX parts (overflow merged into the last) so a
 * choppy reply never turns into a spam burst. Single-paragraph replies pass through.
 */
const MAX_MESSAGE_PARTS = 4;
export function splitIntoMessages(text: string): string[] {
  const parts = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  if (parts.length <= 1) return [text.trim()];
  if (parts.length <= MAX_MESSAGE_PARTS) return parts;
  return [...parts.slice(0, MAX_MESSAGE_PARTS - 1), parts.slice(MAX_MESSAGE_PARTS - 1).join('\n\n')];
}

/** Human-like "typing" pause before sending a follow-up part (~0.8–3s by length). */
function typingDelayMs(text: string): number {
  return Math.min(3000, Math.max(800, text.length * 25));
}

const CLASSIFY_PROMPT = (leadMessage: string, botReply: string) =>
  `Clasifica el estado de esta conversación de ventas tras el último intercambio.

Lead dijo: "${leadMessage.slice(0, 200)}"
Bot respondió: "${botReply.slice(0, 300)}"

Elige UNO:
- active: la conversación sigue abierta; el lead puede responder o aún no ha tomado una decisión final.
- standby: el lead NO califica por perfil (ej. no tiene negocio, no vende servicios, no es el público objetivo). El bot ya se despidió. NO uses esto si el lead solo dijo que no le interesa.
- opted_out: el lead dijo EXPLÍCITAMENTE que no quiere más mensajes, que pare, que no le interesa, o pidió que no lo contacten. Requiere una expresión directa de rechazo, no solo no calificar.
- completed: el lead completó el proceso (agendó, se registró, pagó).

Responde SOLO con JSON: {"status":"active"} o {"status":"standby"} o {"status":"opted_out"} o {"status":"completed"}. Sin explicaciones.`;

const VALID_STATUSES = new Set(['active', 'standby', 'opted_out', 'completed']);

/**
 * Classify whether the conversation reached a terminal state after this turn.
 * Only runs when the bot's reply has no question (optimization — most active
 * turns end with a question). Returns null if still active or on error.
 */
async function classifyConversationOutcome(
  leadMessage: string,
  botReply: string,
  provider: AiProvider,
  apiKey: string,
  modelId: string,
): Promise<Exclude<ConversationStatus, 'active' | 'handed_off'> | null> {
  if (botReply.includes('?')) return null; // has a question → still active

  try {
    let raw: string;

    if (provider === 'anthropic') {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: modelId,
          max_tokens: 32,
          messages: [{ role: 'user', content: CLASSIFY_PROMPT(leadMessage, botReply) }],
        }),
      });
      if (!res.ok) throw new Error(`anthropic classify ${res.status}`);
      const data = await res.json() as { content: { text: string }[] };
      raw = data.content[0]?.text ?? '';
    } else {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: modelId,
          max_tokens: 32,
          response_format: { type: 'json_object' },
          messages: [{ role: 'user', content: CLASSIFY_PROMPT(leadMessage, botReply) }],
        }),
      });
      if (!res.ok) throw new Error(`openai classify ${res.status}`);
      const data = await res.json() as { choices: { message: { content: string } }[] };
      raw = data.choices[0]?.message?.content ?? '';
    }

    const parsed = JSON.parse(raw) as { status?: string };
    const status = parsed.status;
    if (!status || !VALID_STATUSES.has(status)) return null;
    if (status === 'active') return null;
    return status as Exclude<ConversationStatus, 'active' | 'handed_off'>;
  } catch (err) {
    console.error('[classify] failed:', err instanceof Error ? err.message : String(err));
    return null; // fail safe: never block the main flow
  }
}

/** Map our stored turns into the model's user/assistant view. */
function toModelMessages(history: ConversationMessage[]): ChatMessage[] {
  return history.map((m): ChatMessage =>
    m.senderType === 'lead'
      ? { role: 'user', content: m.content }
      : { role: 'assistant', content: m.content },
  );
}

/**
 * Gate checks → load history → generate reply → log outbound → deliver.
 * Called from ctx.waitUntil (debounced) or directly (sync/test path).
 */
export async function runAgentTurn({
  agent,
  conversationId,
  messageId,
  tenant,
  parsed,
  phone,
  debounced,
}: AgentRunParams): Promise<WebhookResult> {
  if (debounced) {
    const isLatest = await isLatestInboundMessage(conversationId, messageId);
    if (!isLatest) {
      console.log(`[debounce] skip conv=${parsed.conversationId} — superseded by newer message`);
      await logBotEvent(tenant.clientId, parsed.conversationId, 'run_superseded', { messageId });
      return { status: 200, body: { skipped: 'superseded', conversationId } };
    }
    console.log(`[debounce] proceeding conv=${parsed.conversationId}`);
  }

  if (!roleEnabled(tenant, FRONT_DESK_ROLE)) {
    return { status: 200, body: { ignored: 'front-desk role disabled for tenant', conversationId } };
  }
  if (await isBotSuppressed(parsed.conversationId)) {
    // A human is handling this thread (handed_off or 5-min sliding window) — stay silent.
    await logBotEvent(tenant.clientId, parsed.conversationId, 'run_suppressed', { stage: 'pre_generate' });
    return { status: 200, body: { ignored: 'bot suppressed (handoff or human active)', conversationId } };
  }

  const history = await loadRecentMessages(conversationId);
  const messages = toModelMessages(history);

  const turn: TurnContext = {
    ghlConversationId: parsed.conversationId,
    ghlContactId: parsed.contactId,
    contactPhone: phone ?? undefined,
    channel: parsed.channel,
  };
  const provider = (tenant.config.provider ?? DEFAULT_PROVIDER) as AiProvider;
  const model = tenant.config.model ?? DEFAULT_MODEL;
  const requestContext = buildAgentRequestContext({
    tenant,
    turn,
    provider,
    model,
    llmApiKey: getAiApiKey(provider),
  });

  console.log(`[agent] generating conv=${parsed.conversationId} model=${model} historyLen=${messages.length}`);
  let result;
  try {
    result = await agent.generate(messages, { requestContext, maxSteps: 5 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[agent] generate failed:', msg);
    logError(tenant.clientId, parsed.conversationId, 'agent_error', {
      error: msg,
      model,
      historyLen: messages.length,
      inbound: parsed.text.slice(0, 120),
    });
    return { status: 500, body: { error: 'agent_generate_failed', conversationId } };
  }
  console.log(`[agent] reply conv=${parsed.conversationId} replyLen=${result.text?.length ?? 0}`);
  // result.text concatenates text from every step when the agent makes multiple tool calls
  // (the model generates narration before each call). Use only the last step's text.
  const steps = (result as { steps?: Array<{ text?: string }> }).steps;
  const reply = steps?.length
    ? (steps.slice().reverse().find((s) => s.text?.trim())?.text?.trim() ?? result.text)
    : result.text;

  // Anti-double guard: a HUMAN may have replied in GHL WHILE we were generating.
  // Re-check before sending so we don't talk over them. We bail BEFORE logging the
  // outbound, so the delivery cron never finds a pending row to re-send.
  // Note: we check isHumanActive (not isBotSuppressed) on purpose — the agent's OWN
  // self-handoff sets handed_off during generation, and its farewell SHOULD still go out.
  if (await isHumanActive(parsed.conversationId)) {
    console.log(`[agent] drop reply conv=${parsed.conversationId} — human took over during generation`);
    await logBotEvent(tenant.clientId, parsed.conversationId, 'run_suppressed', { stage: 'post_generate' });
    return { status: 200, body: { ignored: 'suppressed during generation', conversationId } };
  }

  const ghl = new GhlClient(tenant.tenantId);

  // Classify conversation outcome — runs only when reply has no question (cheap path).
  // This is the reliable fallback for when the agent doesn't call updateConversationStatus itself.
  const hasQuestion = reply.includes('?');
  console.log(`[classify] conv=${parsed.conversationId} hasQuestion=${hasQuestion}`);
  const outcome = await classifyConversationOutcome(parsed.text, reply, provider, getAiApiKey(provider), model);
  console.log(`[classify] outcome=${outcome ?? 'null (active or error)'}`);
  if (outcome) {
    try {
      await updateConversationStatus(parsed.conversationId, outcome);
      console.log(`[conv] status→${outcome} conv=${parsed.conversationId}`);
      // Mirror the state onto the GHL contact as a tag (transparency / sync).
      const tag = STATUS_TAGS[outcome];
      if (tag) {
        ghl.addContactTags(parsed.contactId, [tag]).catch((e: unknown) =>
          console.error('[tags] add on classify failed:', e instanceof Error ? e.message : String(e)),
        );
      }
    } catch (e) {
      console.error('[conv] updateConversationStatus failed:', e instanceof Error ? e.message : String(e));
    }
  }

  // Split into separate messages on paragraph breaks; send each with a short
  // human-like gap. Each part is its own logged + tracked outbound message.
  const parts = splitIntoMessages(reply);
  for (const [i, part] of parts.entries()) {
    if (i > 0) await new Promise<void>((r) => setTimeout(r, typingDelayMs(part)));

    let outId: string | null = null;
    try {
      ({ messageId: outId } = await logMessage({
        p_ghl_conversation_id: parsed.conversationId,
        p_client_id: tenant.clientId,
        p_channel: parsed.channel,
        p_ghl_contact_id: parsed.contactId,
        p_contact_phone: phone ?? null,
        p_direction: 'outbound',
        p_sender_type: 'bot',
        p_content: part,
        p_agent_role: FRONT_DESK_ROLE,
        p_human_agent_id: null,
        p_model: model,
        p_sent_at: null,
      }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[db] outbound logMessage failed:', msg);
      logError(tenant.clientId, parsed.conversationId, 'db_error', { error: msg, stage: 'outbound_log' });
    }

    const ghlMessageId = await sendWithRetry(ghl, {
      contactId: parsed.contactId,
      channel: parsed.channel,
      text: part,
      phone: phone ?? undefined,
    });

    if (ghlMessageId && outId) {
      // setGhlMessageId must run before the outbound echo arrives so isBotMessageById works.
      try {
        await setGhlMessageId(outId, ghlMessageId);
        await markDelivered(outId);
      } catch (e: unknown) {
        console.error('[db] post-send DB update failed:', e instanceof Error ? e.message : String(e));
      }
    } else if (!ghlMessageId) {
      console.error('[ghl] sendMessage failed after retry — leaving pending for cron');
      logError(tenant.clientId, parsed.conversationId, 'delivery_error', {
        channel: parsed.channel, hasPhone: !!phone, part: i, parts: parts.length, note: 'inline retry exhausted',
      });
    }
  }

  // Schedule tier-1 follow-up after every bot reply (RPC no-ops if conv is not active).
  // Must be awaited — fire-and-forget gets killed when waitUntil resolves.
  const tiers = tenant.config.followUpTiers;
  const tier1 = tiers?.find((t) => t.tier === 1);
  if (tier1) {
    try {
      await scheduleFollowUp(conversationId, 1, tier1.delayMinutes);
    } catch (e) {
      console.error('[followup] scheduleFollowUp failed:', e instanceof Error ? e.message : String(e));
    }
  }

  return { status: 200, body: { replied: true, conversationId } };
}

export async function handleInboundWebhook(
  payload: GhlInboundWebhook,
  agent: Agent,
  ctx?: ExecutionCtx,
): Promise<WebhookResult> {
  // Signature already verified at the route handler (raw body, before parse).
  const parsed = parseInboundWebhook(payload);
  if (!parsed) {
    return { status: 200, body: { ignored: 'unparseable or non-message payload' } };
  }

  const tenant = await resolveTenant(parsed.locationId);
  if (!tenant) {
    return { status: 200, body: { ignored: 'unknown or inactive tenant', locationId: parsed.locationId } };
  }

  // GHL WhatsApp webhooks omit the phone — fetch it from the Contacts API if needed.
  const phone = parsed.phone ?? await new GhlClient(tenant.tenantId).getContactPhone(parsed.contactId);

  console.log(`[webhook] inbound conv=${parsed.conversationId} contact=${parsed.contactId} channel=${parsed.channel} hasPhone=${!!phone}`);

  const { conversationId, messageId } = await logMessage({
    p_ghl_conversation_id: parsed.conversationId,
    p_client_id: tenant.clientId,
    p_channel: parsed.channel,
    p_ghl_contact_id: parsed.contactId,
    p_contact_phone: phone ?? null,
    p_direction: 'inbound',
    p_sender_type: 'lead',
    p_content: parsed.text,
    p_agent_role: null,
    p_human_agent_id: null,
    p_model: null,
    p_sent_at: null,
    p_ghl_message_id: parsed.messageId ?? null,
  });
  if (!conversationId) {
    return { status: 200, body: { ignored: 'duplicate message', messageId: parsed.messageId } };
  }

  // Cancel any pending follow-ups — the lead is back. Fire-and-forget; non-blocking.
  cancelFollowUps(conversationId).catch((e: unknown) => {
    console.error('[followup] cancelFollowUps failed:', e instanceof Error ? e.message : String(e));
  });
  // Reactivate if the conversation was in a terminal state (standby/completed/opted_out).
  reactivateConversation(parsed.conversationId).catch((e: unknown) => {
    console.error('[followup] reactivateConversation failed:', e instanceof Error ? e.message : String(e));
  });

  // Per-tenant reply gating (the inbound is already stored — we only gate the reply).
  // Test mode takes precedence: when an allowlist exists, reply only to those
  // contacts (any channel). Otherwise the channel must be enabled (null = silent).
  if (inTestMode(tenant)) {
    if (!tenant.testContactIds?.includes(parsed.contactId)) {
      console.log(`[gate] test-mode skip conv=${parsed.conversationId} contact=${parsed.contactId}`);
      await logBotEvent(tenant.clientId, parsed.conversationId, 'test_mode_skip', { contactId: parsed.contactId });
      return { status: 200, body: { ignored: 'test mode: contact not in allowlist', conversationId } };
    }
  } else if (!channelEnabled(tenant, parsed.channel)) {
    console.log(`[gate] channel disabled conv=${parsed.conversationId} channel=${parsed.channel}`);
    await logBotEvent(tenant.clientId, parsed.conversationId, 'channel_disabled', { channel: parsed.channel });
    return { status: 200, body: { ignored: 'channel not enabled for tenant', channel: parsed.channel, conversationId } };
  }

  // Trigger-keyword entry gate: some tenants only let the bot ENTER a conversation
  // when the first message contains a keyword (e.g. ad CTA "manda Agente"). Once a
  // conversation is activated it flows normally — the keyword isn't required again.
  if (hasTriggerKeywords(tenant)) {
    const matched = messageMatchesTrigger(parsed.text, tenant.triggerKeywords ?? []);
    const state = await botActivation(conversationId, matched);
    if (state === 'gated') {
      console.log(`[gate] trigger keyword required conv=${parsed.conversationId}`);
      await logBotEvent(tenant.clientId, parsed.conversationId, 'keyword_required', { text: parsed.text.slice(0, 80) });
      return { status: 200, body: { ignored: 'trigger keyword required', conversationId } };
    }
    if (state === 'activated') {
      await logBotEvent(tenant.clientId, parsed.conversationId, 'bot_activated', { via: 'keyword' });
    }
  }

  if (!messageId) {
    // Shouldn't happen with migration 0011 applied, but fail safe: run immediately without debounce.
    console.error('[webhook] logMessage returned null messageId — skipping debounce');
    return runAgentTurn({ agent, conversationId, messageId: '', tenant, parsed, phone, debounced: false });
  }

  const runParams: AgentRunParams = { agent, conversationId, messageId, tenant, parsed, phone, debounced: true };

  if (ctx) {
    ctx.waitUntil(
      new Promise<void>((resolve) => setTimeout(resolve, DEBOUNCE_MS))
        .then(() => runAgentTurn(runParams))
        .catch((err) => {
          console.error('[debounce] unhandled error:', err instanceof Error ? err.message : String(err));
        }),
    );
    console.log(`[debounce] scheduled conv=${parsed.conversationId} delay=${DEBOUNCE_MS}ms`);
    return { status: 200, body: { debounced: true, conversationId } };
  }

  // Sync fallback: no CF execution context (test / non-CF environments).
  // Skip the debounce gate since there's no concurrent handler to race against.
  return runAgentTurn({ ...runParams, debounced: false });
}
