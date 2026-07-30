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
import { resolveAiApiKey } from '../core/env.js';
import {
  usageFromAgentResult,
  usageFromAnthropicResponse,
  usageFromOpenAiResponse,
} from '../core/llm-usage.js';
import { channelEnabled, hasTriggerKeywords, inTestMode, matchesDemoOff, matchesDemoOn, matchVariantKeyword, messageMatchesTrigger, resolveTenant, roleEnabled } from '../core/tenant.js';
import { buildAgentRequestContext } from '../core/runtime-context.js';
import type { AiProvider, ConversationMessage, ConversationStatus, TenantContext, TurnContext } from '../core/types.js';
import {
  cancelFollowUps,
  botActivation,
  getConversationPersona,
  setActiveRole,
  isBotSuppressed,
  isHumanActive,
  isLatestInboundMessage,
  loadActiveAppointment,
  loadRecentMessages,
  logBotEvent,
  logError,
  logLlmUsage,
  logMessage,
  markDelivered,
  reactivateConversation,
  scheduleFollowUp,
  setGhlMessageId,
  setPromptVariant,
  updateConversationContact,
  updateConversationStatus,
  setConversationContactKeys,
  getConversationContactKeys,
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

/** The turn payload handed to the DO — everything runAgentTurn needs except the agent
 *  (rebuilt inside the DO) and the debounce flag (always true on the DO path). Must be
 *  structured-clone-serializable (DO storage + RPC): tenant/parsed are plain data. */
export type ScheduledTurn = Omit<AgentRunParams, 'agent' | 'debounced'>;

/** Minimal shape of the ConversationDO namespace we need — avoids a value import cycle. */
export interface TurnDONamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): { scheduleTurn(params: ScheduledTurn): Promise<void> };
}

/**
 * Rollout flag for the Durable-Object turn path. `process.env.DO_TURNS`:
 *   unset/empty → off (legacy waitUntil path, zero risk)
 *   "*" or "all" → every tenant
 *   comma list of tenantIds → only those tenants
 */
function doTurnsEnabled(tenant: TenantContext): boolean {
  const flag = process.env.DO_TURNS?.trim();
  if (!flag) return false;
  if (flag === '*' || flag === 'all') return true;
  return flag.split(',').map((s) => s.trim()).includes(tenant.tenantId);
}

type ChatMessage = { role: 'user'; content: string } | { role: 'assistant'; content: string };

/** Outcome of a send: whether GHL accepted it, its id if we could read one, and the
 *  GHL error (status + body) on failure so a dropped delivery is diagnosable. */
type SendOutcome = { delivered: boolean; ghlMessageId: string | null; error?: string; resolvedContactId?: string | null };

/**
 * One send attempt. A 2xx from GHL (sendMessage returns) means the message was
 * ACCEPTED — we treat it as delivered even if we couldn't parse the id, because
 * the send is NOT idempotent and retrying an accepted message double-sends it.
 * Only a thrown error (network failure / non-2xx) counts as not-delivered.
 */
async function trySend(ghl: GhlClient, params: Parameters<GhlClient['sendMessage']>[0]): Promise<SendOutcome> {
  try {
    const { ghlMessageId, resolvedContactId } = await ghl.sendMessage(params);
    return { delivered: true, ghlMessageId: ghlMessageId || null, resolvedContactId: resolvedContactId ?? null };
  } catch (e) {
    return { delivered: false, ghlMessageId: null, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Attempt delivery with one inline retry after 1.5s. Retries ONLY a genuine
 * failure (the first attempt threw) — never after a 2xx, so an accepted-but-
 * unparsed send is not double-delivered. If both attempts fail to deliver, the
 * DB row stays delivery_status='pending' and the cron picks it up.
 */
async function sendWithRetry(ghl: GhlClient, params: Parameters<GhlClient['sendMessage']>[0]): Promise<SendOutcome> {
  const first = await trySend(ghl, params);
  if (first.delivered) return first;
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
 * Everything an auxiliary (non-agent) model call needs: which key to use, and
 * where to bill the tokens. These helpers hit the provider REST APIs directly
 * rather than going through Mastra, so they'd otherwise be invisible spend —
 * they run on every turn and add up.
 */
interface AuxLlmCall {
  clientId: string;
  ghlConversationId: string;
  provider: AiProvider;
  apiKey: string;
  model: string;
  /** 'platform' or the tenant's ai_key_ref — recorded on the usage row. */
  keySource: string;
}

/** Record an auxiliary call's tokens. Never throws; usage must not break a turn. */
function recordAuxUsage(llm: AuxLlmCall, callKind: string, body: unknown): void {
  const usage = llm.provider === 'anthropic'
    ? usageFromAnthropicResponse(body)
    : usageFromOpenAiResponse(body);
  if (!usage) return;
  void logLlmUsage({
    clientId: llm.clientId,
    ghlConversationId: llm.ghlConversationId,
    callKind,
    provider: llm.provider,
    model: llm.model,
    usage,
    keySource: llm.keySource,
  });
}

/**
 * Classify whether the conversation reached a terminal state after this turn.
 * Only runs when the bot's reply has no question (optimization — most active
 * turns end with a question). Returns null if still active or on error.
 */
async function classifyConversationOutcome(
  leadMessage: string,
  botReply: string,
  llm: AuxLlmCall,
): Promise<Exclude<ConversationStatus, 'active' | 'handed_off'> | null> {
  if (botReply.includes('?')) return null; // has a question → still active

  try {
    let raw: string;

    if (llm.provider === 'anthropic') {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': llm.apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: llm.model,
          max_tokens: 32,
          messages: [{ role: 'user', content: CLASSIFY_PROMPT(leadMessage, botReply) }],
        }),
      });
      if (!res.ok) throw new Error(`anthropic classify ${res.status}`);
      const data = await res.json() as { content: { text: string }[] };
      recordAuxUsage(llm, 'classify', data);
      raw = data.content[0]?.text ?? '';
    } else {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: `Bearer ${llm.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: llm.model,
          max_tokens: 32,
          response_format: { type: 'json_object' },
          messages: [{ role: 'user', content: CLASSIFY_PROMPT(leadMessage, botReply) }],
        }),
      });
      if (!res.ok) throw new Error(`openai classify ${res.status}`);
      const data = await res.json() as { choices: { message: { content: string } }[] };
      recordAuxUsage(llm, 'classify', data);
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

const EXTRACT_NAME_PROMPT = (assistantQuestion: string, leadMessage: string, storedName: string) =>
  `El asistente le pidió su nombre al usuario. Extrae el NOMBRE DE LA PERSONA si lo dio.

Nombre guardado hoy en el sistema: "${storedName}"
El asistente preguntó: "${assistantQuestion.slice(0, 300)}"
El usuario respondió: "${leadMessage.slice(0, 200)}"

Devuelve el nombre propio de la persona (nombre y, si lo da, apellido). Reglas:
- Si el usuario NO dio un nombre de persona (solo saludó, hizo una pregunta, dio el nombre de su NEGOCIO, o solo confirmó el que ya estaba), devuelve null.
- Si solo confirmó que el nombre guardado es correcto, devuelve ese mismo nombre.
- No inventes ni completes apellidos que no dijo.

Responde SOLO con JSON: {"name":"<nombre>"} o {"name":null}. Sin explicaciones.`;

/**
 * Deterministic backstop for the contact-name correction: OpenAI models routinely skip the
 * side-effect-only updateContactName tool, so we don't rely on the agent calling it. When a
 * tenant opts in (promptOverrides.confirmContactName) and we're in the opening exchanges, we
 * extract the personal name from the lead's reply with a cheap model call and write it to GHL
 * directly if it differs from what's stored. Best-effort — never blocks or fails the turn.
 */
async function correctContactName(
  ghl: GhlClient,
  contactId: string,
  assistantQuestion: string,
  leadMessage: string,
  llm: AuxLlmCall,
): Promise<void> {
  try {
    const current = await ghl.getContact(contactId);
    const storedName = current?.name?.trim() ?? '';

    let raw: string;
    if (llm.provider === 'anthropic') {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': llm.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({
          model: llm.model,
          max_tokens: 32,
          messages: [{ role: 'user', content: EXTRACT_NAME_PROMPT(assistantQuestion, leadMessage, storedName) }],
        }),
      });
      if (!res.ok) throw new Error(`anthropic extract-name ${res.status}`);
      const data = await res.json() as { content: { text: string }[] };
      recordAuxUsage(llm, 'extract-name', data);
      raw = data.content[0]?.text ?? '';
    } else {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: `Bearer ${llm.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: llm.model,
          max_tokens: 32,
          response_format: { type: 'json_object' },
          messages: [{ role: 'user', content: EXTRACT_NAME_PROMPT(assistantQuestion, leadMessage, storedName) }],
        }),
      });
      if (!res.ok) throw new Error(`openai extract-name ${res.status}`);
      const data = await res.json() as { choices: { message: { content: string } }[] };
      recordAuxUsage(llm, 'extract-name', data);
      raw = data.choices[0]?.message?.content ?? '';
    }

    const extracted = (JSON.parse(raw) as { name?: string | null }).name?.trim();
    if (!extracted) return; // no personal name given
    if (storedName && extracted.toLowerCase() === storedName.toLowerCase()) return; // already correct

    const parts = extracted.replace(/\s+/g, ' ').split(' ');
    await ghl.updateContactName(contactId, { firstName: parts[0] ?? extracted, lastName: parts.slice(1).join(' ') });
    console.log(`[contact-name] corrected "${storedName}" → "${extracted}"`);
  } catch (err) {
    console.error('[contact-name] backstop failed (non-blocking):', err instanceof Error ? err.message : String(err));
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

  // Read the persona fresh at turn time (a demo keyword may have flipped it since
  // scheduling, and the campaign variant is pinned on the conversation row).
  let activeRole: string | null = null;
  let demoStartedAt: string | null = null;
  let promptVariant: string | null = null;
  try {
    ({ activeRole, demoStartedAt, promptVariant } = await getConversationPersona(conversationId));
  } catch (e) {
    console.error('[demo] getConversationPersona failed:', e instanceof Error ? e.message : String(e));
  }

  // In demo mode, start clean: only load history since demo was activated so the persona
  // doesn't inherit pre-demo context (e.g. a completed booking).
  const sinceTs = activeRole === 'demo' && demoStartedAt ? demoStartedAt : undefined;
  const history = await loadRecentMessages(conversationId, 20, sinceTs);
  const messages = toModelMessages(history);

  const ghl = new GhlClient(tenant.tenantId);

  // Fetch the contact's stored name only while the bot hasn't spoken yet — the opening
  // name-confirmation window. Avoids an extra GHL call on every later turn. The same fetch
  // also grabs the contact's phone/email — the keys GHL merges on — so if GHL merges this
  // contact away moments later (Instant-Form dedup by phone), the send can still re-resolve
  // the surviving contact (see sendMessage merge recovery). Empirically this fetch succeeds
  // right before the send that then 404s, so it's our reliable capture point.
  let contactName: string | undefined;
  let contactPhone: string | undefined = phone ?? undefined;
  let contactEmail: string | undefined;
  let fetchedContact = false;
  if (!history.some((m) => m.senderType === 'bot')) {
    try {
      const contact = await ghl.getContact(parsed.contactId);
      if (contact) {
        fetchedContact = true;
        contactName = contact.name?.trim() || undefined;
        contactPhone = contactPhone ?? contact.phone;
        contactEmail = contact.email;
        if (contact.phone || contact.email) {
          setConversationContactKeys(parsed.conversationId, { phone: contact.phone, email: contact.email }).catch(
            (e: unknown) => console.error('[merge-keys] persist failed (non-blocking):', e instanceof Error ? e.message : String(e)),
          );
        }
      }
    } catch (e) {
      console.error('[contact-name] fetch failed (non-blocking):', e instanceof Error ? e.message : String(e));
    }
  }
  // Later turns (bot already spoke) or a failed fetch: fall back to the merge keys captured
  // at inbound / turn 1, so a send that hits CONTACT_NOT_FOUND can still recover.
  if (!fetchedContact && (!contactPhone || !contactEmail)) {
    try {
      const keys = await getConversationContactKeys(parsed.conversationId);
      contactPhone = contactPhone ?? keys.phone ?? undefined;
      contactEmail = contactEmail ?? keys.email ?? undefined;
    } catch (e) {
      console.error('[merge-keys] read failed (non-blocking):', e instanceof Error ? e.message : String(e));
    }
  }

  // Surface the contact's active appointment so the agent knows it already booked and never
  // re-checks availability against its own just-created appointment (the self-block class).
  // Skipped in demo mode: the demo starts clean and must not inherit a real prior booking.
  let activeAppointment: { startTime: string; service?: string } | undefined;
  if (activeRole !== 'demo') {
    try {
      const appt = await loadActiveAppointment(tenant.clientId, parsed.contactId);
      if (appt) activeAppointment = { startTime: appt.startTime, service: appt.service ?? undefined };
    } catch (e) {
      console.error('[active-appointment] load failed (non-blocking):', e instanceof Error ? e.message : String(e));
    }
  }

  const turn: TurnContext = {
    ghlConversationId: parsed.conversationId,
    ghlContactId: parsed.contactId,
    contactPhone: phone ?? undefined,
    contactName,
    channel: parsed.channel,
    activeRole: activeRole ?? undefined,
    promptVariant: promptVariant ?? undefined,
    activeAppointment,
  };
  const provider = (tenant.config.provider ?? DEFAULT_PROVIDER) as AiProvider;
  const model = tenant.config.model ?? DEFAULT_MODEL;
  // Per-tenant key when the tenant has one, so provider-side spend lands on that
  // client's own key/project. Falls back to the platform key rather than going
  // silent (see resolveAiApiKey) — but a fallback is logged, never swallowed,
  // because from here on every usage row would be misattributed.
  const aiKey = resolveAiApiKey(provider, tenant.config.aiKeyRef);
  if (aiKey.fellBack) {
    console.error(
      `[ai-key] tenant=${tenant.tenantId} ai_key_ref="${tenant.config.aiKeyRef}" has no Worker secret — using the platform key`,
    );
    await logBotEvent(tenant.clientId, parsed.conversationId, 'ai_key_fallback', {
      keyRef: tenant.config.aiKeyRef,
      provider,
    });
  }
  const aux: AuxLlmCall = {
    clientId: tenant.clientId,
    ghlConversationId: parsed.conversationId,
    provider,
    apiKey: aiKey.apiKey,
    model,
    keySource: aiKey.source,
  };
  const requestContext = buildAgentRequestContext({
    tenant,
    turn,
    provider,
    model,
    llmApiKey: aiKey.apiKey,
  });

  console.log(`[agent] generating conv=${parsed.conversationId} model=${model} historyLen=${messages.length}`);
  let result;
  try {
    // 8 steps: a booking turn can chain getAvailability + bookAppointment (which also saves
    // the reminder number) + updateConversationStatus and still leave room for the final
    // written reply. Too low
    // and the turn exhausts steps mid-flow and emits only a pre-tool intro (truncated reply).
    result = await agent.generate(messages, { requestContext, maxSteps: 8 });
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
  // The agent turn is the bulk of the spend — record it before any of the
  // early-return paths below (human takeover, etc.) can skip it. The tokens were
  // burned whether or not we end up sending the reply.
  const turnUsage = usageFromAgentResult(result);
  if (turnUsage) {
    void logLlmUsage({
      clientId: tenant.clientId,
      ghlConversationId: parsed.conversationId,
      callKind: FRONT_DESK_ROLE,
      provider,
      model,
      usage: turnUsage,
      keySource: aiKey.source,
    });
  }
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

  // Deterministic name-correction backstop (opt-in per tenant). Runs only in the opening
  // exchanges — after the bot has asked for the name (>=1 prior bot message) but before the
  // conversation moves on (<=2) — so we don't pay an extra model call every turn. We don't
  // rely on the agent's updateContactName tool: OpenAI models skip it (no result needed).
  const confirmContactName =
    (tenant.config.promptOverrides as { confirmContactName?: boolean } | null | undefined)?.confirmContactName === true;
  if (confirmContactName) {
    const priorBotMessages = history.filter((m) => m.senderType === 'bot').length;
    if (priorBotMessages >= 1 && priorBotMessages <= 2) {
      const lastBotMessage = history.slice().reverse().find((m) => m.senderType === 'bot')?.content ?? '';
      await correctContactName(ghl, parsed.contactId, lastBotMessage, parsed.text, aux);
    }
  }

  // Classify conversation outcome — runs only when reply has no question (cheap path).
  // This is the reliable fallback for when the agent doesn't call updateConversationStatus itself.
  const hasQuestion = reply.includes('?');
  console.log(`[classify] conv=${parsed.conversationId} hasQuestion=${hasQuestion}`);
  const outcome = await classifyConversationOutcome(parsed.text, reply, aux);
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
  // May be corrected mid-loop if GHL merged the webhook contactId away (see resolvedContactId).
  let sendContactId = parsed.contactId;
  for (const [i, part] of parts.entries()) {
    if (i > 0) await new Promise<void>((r) => setTimeout(r, typingDelayMs(part)));

    let outId: string | null = null;
    try {
      ({ messageId: outId } = await logMessage({
        p_ghl_conversation_id: parsed.conversationId,
        p_client_id: tenant.clientId,
        p_channel: parsed.channel,
        p_ghl_contact_id: parsed.contactId,
        p_contact_phone: contactPhone ?? null,
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

    const { delivered, ghlMessageId, error: sendError, resolvedContactId } = await sendWithRetry(ghl, {
      contactId: sendContactId,
      channel: parsed.channel,
      text: part,
      phone: contactPhone ?? undefined,
      email: contactEmail,
      conversationId: parsed.conversationId,
    });

    // GHL merged the webhook contactId away and we recovered the live one: reuse it for
    // the remaining parts and persist it so future turns/follow-ups don't hit the same wall.
    if (resolvedContactId && resolvedContactId !== sendContactId) {
      sendContactId = resolvedContactId;
      updateConversationContact(parsed.conversationId, resolvedContactId).catch((e: unknown) =>
        console.error('[ghl] updateConversationContact failed:', e instanceof Error ? e.message : String(e)),
      );
    }

    if (delivered && outId) {
      // Mark delivered so the pending-delivery cron never re-sends it (that would
      // double-deliver too). setGhlMessageId, when we have the id, lets the outbound
      // echo be recognized as ours (isBotMessageById); when GHL accepted but we
      // couldn't read the id, the content guard in the outbound handler is the backstop.
      try {
        if (ghlMessageId) await setGhlMessageId(outId, ghlMessageId);
        await markDelivered(outId);
      } catch (e: unknown) {
        console.error('[db] post-send DB update failed:', e instanceof Error ? e.message : String(e));
      }
    } else if (!delivered) {
      console.error('[ghl] sendMessage failed after retry — leaving pending for cron');
      logError(tenant.clientId, parsed.conversationId, 'delivery_error', {
        channel: parsed.channel, hasPhone: !!contactPhone, hasEmail: !!contactEmail, part: i, parts: parts.length,
        note: 'inline retry exhausted', error: sendError,
      });
    }
  }

  // Start a fresh follow-up cycle after every bot reply: schedule cadence position 1
  // (RPC no-ops if conv is not active). Every inbound already cancelled the prior
  // pending nudge, so this resets the cadence clock while the angle cursor advances
  // independently (see followup-runner). Must be awaited — a detached promise gets
  // killed when waitUntil resolves.
  const firstDelay = tenant.config.followUpCadence?.[0];
  if (firstDelay !== undefined) {
    try {
      await scheduleFollowUp(conversationId, 1, firstDelay, tenant.config.timezone, tenant.config.quietHours);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[followup] scheduleFollowUp failed:', msg);
      // Surface it — a swallowed failure here is exactly why a delivered reply can end
      // up with no follow-up scheduled, invisible until now (logBotEvent never throws).
      await logBotEvent(tenant.clientId, parsed.conversationId, 'db_error', {
        stage: 'schedule_follow_up', tier: 1, error: msg,
      });
    }
  }

  return { status: 200, body: { replied: true, conversationId } };
}

export async function handleInboundWebhook(
  payload: GhlInboundWebhook,
  agent: Agent,
  ctx?: ExecutionCtx,
  doNamespace?: TurnDONamespace,
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

  // GHL FB/IG (and WhatsApp) webhooks omit phone/email — fetch them from the contact while
  // it's still alive. Besides giving WhatsApp its phone, this is the EARLY capture of the
  // merge keys: if GHL later merges this contact away, the send re-resolves the survivor by
  // phone/email (persisted just below). Only fetched when the payload didn't already carry a phone.
  let phone = parsed.phone;
  let inboundEmail: string | undefined;
  if (!phone) {
    const contact = await new GhlClient(tenant.tenantId).getContact(parsed.contactId);
    phone = contact?.phone;
    inboundEmail = contact?.email;
  }

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

  // Persist the contact's email as a merge key (phone already went in via logMessage above)
  // so a later send can re-resolve a merged-away contact. Fire-and-forget; non-blocking.
  if (inboundEmail) {
    setConversationContactKeys(parsed.conversationId, { email: inboundEmail }).catch((e: unknown) =>
      console.error('[merge-keys] inbound persist failed (non-blocking):', e instanceof Error ? e.message : String(e)),
    );
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

  // Campaign prompt variant (n:1 keyword → variant). Independent of the gate above:
  // a tenant can flavor threads without gating them. First-touch sticky — enforced in
  // SQL (COALESCE), so re-matches are no-ops and only the pinning call logs the event.
  // Best-effort: a variant failure must never block the turn (lead gets the base prompt).
  const variantMatch = matchVariantKeyword(tenant, parsed.text);
  if (variantMatch) {
    try {
      const assigned = await setPromptVariant(parsed.conversationId, variantMatch.variant);
      if (assigned) {
        // known:false is the misconfiguration fingerprint — a keyword mapped to a
        // variant key with no prompt_variants entry. The prompt falls back to base.
        const known = !!(tenant.config.promptVariants as Record<string, unknown> | null)?.[variantMatch.variant];
        if (!known) {
          console.error(`[variant] keyword "${variantMatch.keyword}" maps to unknown variant "${variantMatch.variant}" tenant=${tenant.tenantId}`);
        }
        await logBotEvent(tenant.clientId, parsed.conversationId, 'variant_assigned', {
          variant: variantMatch.variant,
          keyword: variantMatch.keyword,
          known,
        });
      }
    } catch (e) {
      console.error('[variant] setPromptVariant failed (non-blocking):', e instanceof Error ? e.message : String(e));
    }
  }

  if (!messageId) {
    // Shouldn't happen with migration 0011 applied, but fail safe: run immediately without debounce.
    console.error('[webhook] logMessage returned null messageId — skipping debounce');
    return runAgentTurn({ agent, conversationId, messageId: '', tenant, parsed, phone, debounced: false });
  }

  // Demo persona toggle: a control keyword flips this conversation between the tenant's
  // normal front-desk agent and the demo persona (any sender). Absolute set, not a toggle:
  // on-keyword → 'demo', off-keyword → null. The flip is written BEFORE the turn is scheduled,
  // so the turn (which reads active_role fresh) already answers with the selected persona.
  if (matchesDemoOn(tenant, parsed.text)) {
    try {
      await setActiveRole(parsed.conversationId, 'demo');
      await logBotEvent(tenant.clientId, parsed.conversationId, 'demo_toggled', { to: 'demo' });
    } catch (e) {
      console.error('[demo] setActiveRole(demo) failed:', e instanceof Error ? e.message : String(e));
    }
  } else if (matchesDemoOff(tenant, parsed.text)) {
    try {
      await setActiveRole(parsed.conversationId, null);
      await logBotEvent(tenant.clientId, parsed.conversationId, 'demo_toggled', { to: 'front-desk' });
    } catch (e) {
      console.error('[demo] setActiveRole(null) failed:', e instanceof Error ? e.message : String(e));
    }
  }

  const runParams: AgentRunParams = { agent, conversationId, messageId, tenant, parsed, phone, debounced: true };

  // Durable-turn path (flagged rollout): hand the turn to the conversation's DO, which
  // debounces via a durable Alarm and runs it serialized — no waitUntil drop, no double-run.
  if (doNamespace && ctx && doTurnsEnabled(tenant)) {
    try {
      const stub = doNamespace.get(doNamespace.idFromName(conversationId));
      await stub.scheduleTurn({ conversationId, messageId, tenant, parsed, phone });
      // Must be awaited: the request returns immediately after, and a fire-and-forget
      // event promise gets killed before it writes (see db/queries.ts logBotEvent note).
      await logBotEvent(tenant.clientId, parsed.conversationId, 'turn_scheduled', { via: 'durable-object' });
      console.log(`[DO] scheduled conv=${parsed.conversationId}`);
      return { status: 200, body: { scheduled: 'durable-object', conversationId } };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[DO] scheduleTurn failed, falling back to waitUntil:', msg);
      logError(tenant.clientId, parsed.conversationId, 'db_error', { stage: 'do_schedule', error: msg });
      // fall through to the legacy waitUntil path below
    }
  }

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
