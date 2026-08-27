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
import { usageFromAgentResult } from '../core/llm-usage.js';
import { channelEnabled, hasTriggerKeywords, inTestMode, matchesDemoOff, matchesDemoOn, matchVariantKeyword, messageMatchesTrigger, resolveTenant, roleEnabled } from '../core/tenant.js';
import { buildAgentRequestContext } from '../core/runtime-context.js';
import { hasHumanReplies, toModelMessages } from '../core/model-messages.js';
import { cadenceForRound, totalRounds } from '../core/reactivation-rounds.js';
import { auxReasoningEffort } from '../core/reasoning.js';
import type { AiProvider, ConversationMessage, ConversationStatus, DemoHandoff, FollowUpKind, TenantContext, TurnContext } from '../core/types.js';
import { DEMO_REMINDER_CADENCE } from '../core/types.js';
import {
  cancelFollowUps,
  botActivation,
  countBotMessagesSince,
  endDemoSession,
  findUnansweredInbound,
  firstInboundAfter,
  getActiveDemoSession,
  getLatestDemoSession,
  type SimulatedBooking,
  getConversationPersona,
  setActiveRole,
  getHumanActiveUntil,
  hasReplyAfter,
  isBotSuppressed,
  isHumanActive,
  isLatestInboundMessage,
  loadRecentMessages,
  logBotEvent,
  logError,
  logLlmUsage,
  logMessage,
  markDelivered,
  reactivateConversation,
  countSentDemoReminders,
  scheduleFollowUp,
  setGhlMessageId,
  setMessageContent,
  setPromptVariant,
  updateConversationContact,
  updateConversationStatus,
  setConversationContactKeys,
  getConversationContactKeys,
  setConversationAttribution,
} from '../db/queries.js';
import { findUpcomingAppointment } from '../db/upcoming-appointment.js';
import { queueCapiEvent, queueCapiStatusEvent } from '../meta/capi.js';
import { extractCapiIdentity } from '../meta/capi-config.js';
import { GhlClient } from '../ghl/client.js';
import { parseInboundWebhook } from '../ghl/webhook.js';
import { transcribeAudio } from '../core/transcribe.js';
import { demoEndTag, STATUS_TAGS } from '../ghl/tags.js';
import type { GhlInboundWebhook, InboundAttachment, ParsedInbound } from '../ghl/types.js';
import { DEFAULT_MODEL, DEFAULT_PROVIDER, FRONT_DESK_ROLE } from '../roles/front-desk/index.js';
import { buildDemoEndAnnouncement, buildDemoStartAnnouncement } from '../roles/front-desk/prompt.js';
import { AUX_MAX_COMPLETION_TOKENS, recordAuxUsage, type AuxLlmCall } from './aux-llm.js';
import { classifyNeedsReply, RESUME_TAIL_SIZE } from './resume-gate.js';

/**
 * Milliseconds to wait after the last inbound message before running the agent.
 * Coalesces a burst of rapid messages into one reply. 15s tolerates natural
 * typing pauses (8s split multi-message turns into separate replies).
 */
const DEBOUNCE_MS = 15_000;
/** DO scheduling: one retry after a short pause before the in-request fallback takes over. */
const DO_SCHEDULE_ATTEMPTS = 2;
const DO_SCHEDULE_RETRY_MS = 2_000;

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
  /** The DO re-ran this turn after the human pause that suppressed it expired. The
   *  thread lived a while without the bot, so the resume gate runs (see resume-gate.ts). */
  resumed?: boolean;
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

/**
 * Store the turn on the conversation's DO and record it; on failure, run the turn from
 * this request after the debounce (the legacy path) so a DO outage degrades to "answered
 * a bit later", never to silence. Runs inside `ctx.waitUntil`, after the webhook has
 * already been answered — see the call site for why it is not awaited in the request.
 *
 * A GHL retry can land in the gap between the 200 and the `turn_scheduled` event; the dedup
 * recovery would then schedule the same turn again, and the DO simply overwrites its pending
 * turn and re-arms the alarm — one run either way.
 */
export async function scheduleOnDurableObject(
  doNamespace: TurnDONamespace,
  runParams: AgentRunParams,
): Promise<void> {
  const { conversationId, messageId, tenant, parsed, phone } = runParams;
  // Two attempts, because a failed RPC does not mean a failed schedule: the DO may have
  // committed the turn and lost only the reply. scheduleTurn is idempotent (it overwrites
  // the one pending slot and re-arms the one alarm), so retrying is free — and if the DO
  // answers the retry, the in-request fallback below never runs and there is no second
  // scheduler racing the alarm. Only a DO that fails twice gets the fallback.
  let lastError = '';
  for (let attempt = 1; attempt <= DO_SCHEDULE_ATTEMPTS; attempt++) {
    try {
      const stub = doNamespace.get(doNamespace.idFromName(conversationId));
      await stub.scheduleTurn({ conversationId, messageId, tenant, parsed, phone });
      await logBotEvent(tenant.clientId, parsed.conversationId, 'turn_scheduled', { via: 'durable-object', attempt });
      console.log(`[DO] scheduled conv=${parsed.conversationId} attempt=${attempt}`);
      return;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      console.error(`[DO] scheduleTurn failed (attempt ${attempt}/${DO_SCHEDULE_ATTEMPTS}):`, lastError);
      if (attempt < DO_SCHEDULE_ATTEMPTS) await new Promise<void>((r) => setTimeout(r, DO_SCHEDULE_RETRY_MS));
    }
  }
  console.error('[DO] giving up on the DO, falling back to in-request turn');
  await logBotEvent(tenant.clientId, parsed.conversationId, 'db_error', {
    stage: 'do_schedule',
    error: lastError,
    attempts: DO_SCHEDULE_ATTEMPTS,
  });
  await logBotEvent(tenant.clientId, parsed.conversationId, 'turn_scheduled', { via: 'wait-until' });
  await new Promise<void>((resolve) => setTimeout(resolve, DEBOUNCE_MS));
  await runAgentTurn(runParams);
}


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
 * Provider, model and key for this tenant's model calls. The tenant's own key when it
 * has one, so provider-side spend lands on that client's key/project; falls back to
 * the platform key rather than going silent (see resolveAiApiKey). The caller logs
 * `fellBack` — once per turn, in the main path.
 */
function resolveTurnLlm(tenant: TenantContext, parsed: ParsedInbound) {
  const provider = (tenant.config.provider ?? DEFAULT_PROVIDER) as AiProvider;
  const model = tenant.config.model ?? DEFAULT_MODEL;
  const aiKey = resolveAiApiKey(provider, tenant.config.aiKeyRef);
  const aux: AuxLlmCall = {
    clientId: tenant.clientId,
    ghlConversationId: parsed.conversationId,
    provider,
    apiKey: aiKey.apiKey,
    model,
    keySource: aiKey.source,
  };
  return { provider, model, aiKey, aux };
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
      const auxEffort = auxReasoningEffort(llm.model);
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: `Bearer ${llm.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: llm.model,
          max_completion_tokens: AUX_MAX_COMPLETION_TOKENS,
          ...(auxEffort && { reasoning_effort: auxEffort }),
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
      const auxEffort = auxReasoningEffort(llm.model);
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: `Bearer ${llm.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: llm.model,
          max_completion_tokens: AUX_MAX_COMPLETION_TOKENS,
          ...(auxEffort && { reasoning_effort: auxEffort }),
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

/** Lead-visible stand-in for a media-only message, so no turn is stored blank. */
function placeholderFor(attachments: InboundAttachment[]): string {
  if (attachments.some((a) => a.kind === 'audio')) return '[nota de voz]';
  if (attachments.some((a) => a.kind === 'image')) return '[imagen]';
  return '[archivo adjunto]';
}

/**
 * Turn a media-only inbound into something the agent can actually answer.
 *
 * Audio is transcribed and the transcription REPLACES the placeholder in the store, so
 * every later turn reads plain text instead of "[nota de voz]". Images are not
 * interpreted yet — the agent is told one arrived so it can acknowledge and ask,
 * which beats both silence and a guess. Never throws: media that can't be resolved
 * degrades to the placeholder.
 */
async function resolveAttachments(
  parsed: ParsedInbound,
  messageId: string,
  tenant: TenantContext,
  apiKey: string,
): Promise<string | null> {
  const clientId = tenant.clientId;
  const audio = parsed.attachments.find((a) => a.kind === 'audio');
  if (audio) {
    // Feed the tenant's own vocabulary to the transcriber — service names are the
    // proper nouns a generic model mangles, and a voice note is often ~1 second.
    const services = Array.isArray(tenant.config.services)
      ? (tenant.config.services as Array<{ name?: unknown }>)
          .map((s) => (typeof s?.name === 'string' ? s.name : null))
          .filter((s): s is string => !!s)
      : [];
    const result = await transcribeAudio(audio.url, apiKey, {
      businessName: tenant.config.businessName,
      terms: services,
    });
    if (!result) {
      await logBotEvent(clientId, parsed.conversationId, 'attachment_failed', {
        kind: 'audio',
        stage: 'transcription',
      });
      return null;
    }
    // Keep the lead's words as the message; the marker tells the agent it was spoken
    // (people are terser and less punctuated by voice) without editorializing.
    const text = parsed.text ? `${parsed.text}\n${result.text}` : result.text;
    try {
      await setMessageContent(messageId, text);
    } catch (e) {
      console.error('[attachments] write-back failed:', e instanceof Error ? e.message : String(e));
    }
    await logBotEvent(clientId, parsed.conversationId, 'attachment_received', {
      kind: 'audio',
      transcribed: true,
      durationSec: result.durationSec,
      chars: result.text.length,
    });
    return text;
  }

  const other = parsed.attachments[0];
  if (other) {
    await logBotEvent(clientId, parsed.conversationId, 'attachment_received', {
      kind: other.kind,
      transcribed: false,
    });
  }
  return null;
}

/** Build the closer's context from a demo session's stored lead data. */
function buildDemoHandoff(
  leadData: Record<string, unknown>,
  reason: DemoHandoff['reason'],
  booked: boolean,
): DemoHandoff {
  const lead = leadData as { businessName?: string; businessType?: string; leadName?: string; services?: string[] };
  return {
    reason,
    businessName: lead.businessName,
    businessType: lead.businessType,
    leadName: lead.leadName,
    services: Array.isArray(lead.services) ? lead.services : undefined,
    // Booking inside the demo is the strongest intent signal we have.
    booked,
  };
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
  resumed,
}: AgentRunParams): Promise<WebhookResult> {
  if (debounced) {
    const isLatest = await isLatestInboundMessage(conversationId, messageId);
    if (!isLatest) {
      console.log(`[debounce] skip conv=${parsed.conversationId} — superseded by newer message`);
      await logBotEvent(tenant.clientId, parsed.conversationId, 'run_superseded', { messageId });
      return { status: 200, body: { skipped: 'superseded', conversationId } };
    }
    // Double-run guard. Two schedulers can converge on one message — the DO alarm and the
    // in-request fallback (when the DO RPC fails AFTER the DO committed), or the DO alarm
    // and a GHL-retry recovery (when only the turn_scheduled write failed). Both pass the
    // latest-message check above, since it IS the same message. Nothing legitimate replies
    // after an inbound before its turn (follow-ups are cancelled on inbound; a human reply
    // opens the pause), so an outbound after it means the other run already answered.
    if (await hasReplyAfter(conversationId, messageId)) {
      console.log(`[debounce] skip conv=${parsed.conversationId} — already answered by another run`);
      await logBotEvent(tenant.clientId, parsed.conversationId, 'run_superseded', { messageId, reason: 'already_answered' });
      return { status: 200, body: { skipped: 'already_answered', conversationId } };
    }
    console.log(`[debounce] proceeding conv=${parsed.conversationId}`);
  }

  if (!roleEnabled(tenant, FRONT_DESK_ROLE)) {
    return { status: 200, body: { ignored: 'front-desk role disabled for tenant', conversationId } };
  }
  if (await isBotSuppressed(parsed.conversationId)) {
    // A human is handling this thread — stay silent. When it's the sliding pause (not a
    // permanent handed_off/opted_out mute) hand the expiry back so the DO can re-run
    // this turn then: the lead's message must not die just because a human was around.
    let resumeAt: string | null = null;
    try {
      resumeAt = (await getHumanActiveUntil(parsed.conversationId)) ?? null;
    } catch (e) {
      console.error('[resume] pause expiry read failed:', e instanceof Error ? e.message : String(e));
    }
    await logBotEvent(tenant.clientId, parsed.conversationId, 'run_suppressed', {
      stage: 'pre_generate',
      ...(resumeAt && { resumeAt }),
    });
    return {
      status: 200,
      body: { ignored: 'bot suppressed (handoff or human active)', conversationId, ...(resumeAt && { resumeAt }) },
    };
  }

  // Resume gate: this turn woke up after the human pause that suppressed it. The bot
  // must not answer a message somebody already answered, nor one that asks for nothing
  // ("Gracias" after the human resolved it). Each silence is an explicit event.
  if (resumed) {
    if (await hasReplyAfter(conversationId, messageId)) {
      console.log(`[resume] skip conv=${parsed.conversationId} — already answered during the pause`);
      await logBotEvent(tenant.clientId, parsed.conversationId, 'resume_skipped', { reason: 'answered' });
      return { status: 200, body: { skipped: 'answered', conversationId } };
    }
    const tail = await loadRecentMessages(conversationId, RESUME_TAIL_SIZE);
    if (!(await classifyNeedsReply(tail, resolveTurnLlm(tenant, parsed).aux))) {
      console.log(`[resume] skip conv=${parsed.conversationId} — last message needs no reply`);
      await logBotEvent(tenant.clientId, parsed.conversationId, 'resume_skipped', { reason: 'no_reply_needed' });
      return { status: 200, body: { skipped: 'no_reply_needed', conversationId } };
    }
    console.log(`[resume] proceeding conv=${parsed.conversationId}`);
  }

  // Read the persona fresh at turn time (a demo keyword may have flipped it since
  // scheduling, and the campaign variant is pinned on the conversation row).
  let activeRole: string | null = null;
  let roleStartedAt: string | null = null;
  let demoStartedAt: string | null = null;
  let promptVariant: string | null = null;
  // Fails open to round 0 with the rest of the persona: a transient read failure
  // costs at most one extra round-0 cycle, never a silenced lead.
  let reactivationRound = 0;
  try {
    ({ activeRole, roleStartedAt, demoStartedAt, promptVariant, reactivationRound } =
      await getConversationPersona(conversationId));
  } catch (e) {
    console.error('[demo] getConversationPersona failed:', e instanceof Error ? e.message : String(e));
  }

  // Demo SESSION (0038, the lead-magnet funnel — a manual keyword demo has no session):
  // read it fresh, enforce budget + expiry, and overlay its generated persona. When the
  // budget is exhausted (or the session expired), flip back to the NORMAL persona — the
  // closer — atomically (app_end_demo_session stamps role_started_at at the latest
  // inbound, so the closer sees the lead's last message and none of the roleplay).
  let demoHandoff: DemoHandoff | undefined;
  let demoBooking: SimulatedBooking | null = null;
  /** When the demo ended — bot messages before it are roleplay, not the closer's own. */
  let demoEndedAt: string | undefined;
  /** True only on the turn that ends the demo: that reply is deterministic, not generated. */
  let demoJustEnded = false;
  /** The running session, kept so a booking made DURING this turn can end it. */
  let activeDemoSession: Awaited<ReturnType<typeof getActiveDemoSession>> = null;
  if (activeRole === 'demo') {
    try {
      const session = await getActiveDemoSession(parsed.conversationId);
      if (session) {
        const expired = Date.parse(session.expiresAt) <= Date.now();
        // Budget counts the DEMO's own replies. The announcement ("tu demo está
        // lista") is sent by the normal persona in the startDemo turn, so the meter
        // starts at the lead's first in-character message, not at activation.
        const demoStart = (await firstInboundAfter(conversationId, session.activatedAt)) ?? session.activatedAt;
        const used = await countBotMessagesSince(conversationId, demoStart);
        if (expired || used >= session.messageBudget) {
          const reason = expired ? 'expired' : 'exhausted';
          await endDemoSession(session.id, reason);
          await logBotEvent(tenant.clientId, parsed.conversationId, 'demo_session_ended', {
            sessionId: session.id,
            reason,
            botMessagesUsed: used,
          });
          demoHandoff = buildDemoHandoff(session.leadData, reason, !!session.simulatedBooking);
          demoEndedAt = new Date().toISOString();
          demoJustEnded = true;
          console.log(`[demo-session] ended conv=${parsed.conversationId} reason=${reason} used=${used}`);
          // Funnel outcome onto the GHL contact: completed = used the full budget (hot);
          // incomplete = expired/abandoned (retargeting pool). Best-effort mirror.
          new GhlClient(tenant.tenantId).addContactTags(parsed.contactId, [demoEndTag(reason)]).catch((e: unknown) =>
            console.error('[demo-session] end tag failed (non-blocking):', e instanceof Error ? e.message : String(e)),
          );
          // Re-read: the RPC flipped active_role and stamped role_started_at.
          ({ activeRole, roleStartedAt, demoStartedAt, promptVariant } = await getConversationPersona(conversationId));
        } else {
          // Overlay the session's generated persona (request-scoped; the demo prompt
          // path already reads demoPromptOverrides when active_role='demo').
          tenant.config.demoPromptOverrides = session.promptOverrides;
          // The demo's own booking, surfaced below as activeAppointment so the agent
          // gets the same self-block guard as a real one (see that section).
          demoBooking = session.simulatedBooking;
          activeDemoSession = session;
        }
      }
    } catch (e) {
      // Non-blocking: on a session read/flip failure the turn proceeds as a manual
      // keyword demo (tenant-level demo overrides), never as a dropped reply.
      console.error('[demo-session] check failed (non-blocking):', e instanceof Error ? e.message : String(e));
    }
  } else if (activeRole === 'closer') {
    // Post-demo persona (0040): rebuild the handoff context from the last session on
    // EVERY turn, so the setter flow lasts the whole conversation — not just the turn
    // where the demo ended (which is what made it evaporate after one message).
    try {
      const last = await getLatestDemoSession(parsed.conversationId);
      if (last) {
        const reason = last.endReason === 'expired' ? 'expired' : last.endReason === 'closed' ? 'closed' : 'exhausted';
        demoHandoff = buildDemoHandoff(last.leadData, reason, last.booked);
        demoEndedAt = last.endedAt ?? undefined;
      }
    } catch (e) {
      console.error('[closer] latest session read failed (non-blocking):', e instanceof Error ? e.message : String(e));
    }
  }

  // Resolve any media the lead sent BEFORE loading history, so the transcription is
  // already written back and the turn reads it as an ordinary message. Runs here rather
  // than in the webhook because the webhook must ack GHL fast; the DO owns the slow work.
  if (parsed.attachments?.length && messageId) {
    try {
      await resolveAttachments(parsed, messageId, tenant, resolveAiApiKey('openai', tenant.config.aiKeyRef).apiKey);
    } catch (e) {
      console.error('[attachments] resolve failed (non-blocking):', e instanceof Error ? e.message : String(e));
    }
  }

  // Clean-start history: from when the CURRENT persona took over (demo start OR the
  // closer flip). Legacy fallback for rows stamped before 0038: demo_started_at.
  const sinceTs = roleStartedAt ?? (activeRole === 'demo' && demoStartedAt ? demoStartedAt : undefined);
  const history = await loadRecentMessages(conversationId, 20, sinceTs);
  // The turn the demo ENDS on: the anchor is the lead's last inbound, so any demo replies
  // sent after it (the tail of the roleplay) would land in the closer's context and pull it
  // back into character. Strip them — the handoff section already says what happened. Later
  // closer turns keep their full history: by then every assistant message is the closer's own.
  const messages = toModelMessages(
    demoEndedAt
      ? history.filter((m) => m.senderType === 'lead' || m.sentAt > demoEndedAt!)
      : history,
  );

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
        // Meta CAPI capture (0048/0056): GHL only exposes Meta's matching key on the
        // contact record (ctwa_clid on WhatsApp, PSID on Facebook, IGSID on Instagram) —
        // this fetch is the one place we see it. First-touch sticky in the DB, and the
        // queue's unique event_id makes the lead_started enqueue idempotent, so
        // re-running on turn 2 (bot still hasn't spoken) is a no-op.
        if (tenant.metaCapi) {
          const identity =
            extractCapiIdentity(parsed.channel, contact.attributionSource) ??
            extractCapiIdentity(parsed.channel, contact.lastAttributionSource);
          if (identity) {
            await setConversationAttribution(parsed.conversationId, {
              identity,
              attribution: contact.attributionSource ?? contact.lastAttributionSource,
            }).catch((e: unknown) =>
              console.error('[capi] attribution persist failed (non-blocking):', e instanceof Error ? e.message : String(e)),
            );
            await queueCapiEvent({
              tenant,
              ghlConversationId: parsed.conversationId,
              kind: 'lead_started',
              identity,
              phone: contactPhone ?? null,
            });
          }
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
  // The demo needs the SAME guard against its OWN simulated booking: the sim excludes a
  // booked slot from later availability calls (as a real calendar would), and without this
  // the agent reads its disappearance as "ya se ocupó" and re-offers times — which is
  // exactly what it did on 2026-07-30. Real appointments stay invisible to the demo.
  //
  // Since 0049 this is also the HELP-MODE switch (support prompt + no cadence arming), so
  // the read is GHL-aware: a store row that went stale falls back to getContactAppointments
  // (the package customer whose next session was staff-booked in the GHL calendar). For a
  // tenant with booking disabled EVERY appointment is staff-booked and the store is always
  // empty, so those check GHL on every turn — they're the support-heavy, low-volume ones.
  let activeAppointment: { startTime: string; service?: string } | undefined;
  if (activeRole === 'demo') {
    if (demoBooking) activeAppointment = { startTime: demoBooking.startTime, service: demoBooking.serviceName };
  } else {
    try {
      const staffBookedTenant =
        (tenant.config.promptOverrides as { bookingEnabled?: boolean } | null)?.bookingEnabled === false;
      const appt = await findUpcomingAppointment(tenant.clientId, parsed.contactId, ghl, Date.now(), {
        alwaysCheckGhl: staffBookedTenant,
      });
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
    demoHandoff,
    // Same window the model reads: a teammate's answer outside it is not "seen" either way.
    hasHumanReplies: hasHumanReplies(history),
  };
  // A key fallback is logged, never swallowed, because from here on every usage row
  // would be misattributed.
  const { provider, model, aiKey, aux } = resolveTurnLlm(tenant, parsed);
  if (aiKey.fellBack) {
    console.error(
      `[ai-key] tenant=${tenant.tenantId} ai_key_ref="${tenant.config.aiKeyRef}" has no Worker secret — using the platform key`,
    );
    await logBotEvent(tenant.clientId, parsed.conversationId, 'ai_key_fallback', {
      keyRef: tenant.config.aiKeyRef,
      provider,
    });
  }
  const requestContext = buildAgentRequestContext({
    tenant,
    turn,
    provider,
    model,
    llmApiKey: aiKey.apiKey,
  });

  // The demo just ended: this one reply is DETERMINISTIC, not generated. Two rounds of
  // prompt instructions failed in production — with the lead's last in-character question
  // sitting in the history, the model answered it and jumped to the pitch, never telling
  // the lead the demo was over. The announcement is the hinge of the whole funnel, so the
  // runtime writes it (same principle as the booking slot resolver). Every turn after this
  // one is model-driven again, with the closer persona persisting.
  const forcedReply = demoJustEnded && demoHandoff ? buildDemoEndAnnouncement(demoHandoff) : undefined;

  let reply: string;
  if (forcedReply) {
    reply = forcedReply;
    console.log(`[demo-session] deterministic handover reply conv=${parsed.conversationId}`);
  } else {
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
    reply = steps?.length
      ? (steps.slice().reverse().find((s) => s.text?.trim())?.text?.trim() ?? result.text)
      : result.text;
  }

  // The demo just STARTED on this turn: the normal persona was speaking and startDemo
  // created a session mid-turn. Detected by re-reading (never by parsing the model's
  // steps), the same way the booking below is. The rules of the game ride on that same
  // reply, so the lead learns who answers next BEFORE they write again — leaving it to
  // the prompt is what had ad leads interrogating a roleplayed receptionist about The Bot
  // Crew, burning the demo budget on questions it was never meant to answer.
  //
  // Gated on demoSessionsEnabled so this costs a DB read only for the tenant that can
  // actually have a session; startDemo refuses to create one without the flag anyway.
  //
  // It REPLACES the model's text, it does not append to it. The prompt already forbids
  // writing this announcement ("NO escribas tú el aviso… el sistema lo manda solo") and
  // the model ignored it on 2 of the 2 demos that have ever started: both leads were told
  // twice, in four messages inside eleven seconds. A rule the model breaks every time is
  // not a rule, and the announcement is self-sufficient — who answers next, how to play,
  // what it can't know, and the way out — so nothing of value is dropped with the text.
  if (tenant.demoSessionsEnabled && activeRole !== 'demo' && !activeDemoSession && !forcedReply) {
    try {
      const started = await getActiveDemoSession(parsed.conversationId);
      if (started) {
        const lead = started.leadData as { businessName?: string };
        reply = buildDemoStartAnnouncement(lead.businessName, tenant.demoOffKeywords?.[0]);
        console.log(`[demo-session] deterministic start announcement conv=${parsed.conversationId}`);
      }
    } catch (e) {
      // Non-blocking: worst case the lead gets the agent's own announcement, as before.
      console.error('[demo-session] start check failed (non-blocking):', e instanceof Error ? e.message : String(e));
    }
  }

  // A simulated booking IS the demo's objective, so the session ends the moment it
  // happens — no post-booking small talk. The pitch rides on the confirmation the agent
  // just wrote, which is the strongest moment in the funnel: the lead has literally just
  // watched an assistant book them. Detected by re-reading the session (the tool writes
  // the booking there) rather than parsing tool results out of the model's steps.
  let endedByBooking = false;
  if (activeRole === 'demo' && activeDemoSession && !demoBooking && !forcedReply) {
    try {
      const after = await getActiveDemoSession(parsed.conversationId);
      if (after?.simulatedBooking) {
        await endDemoSession(activeDemoSession.id, 'booked');
        await logBotEvent(tenant.clientId, parsed.conversationId, 'demo_session_ended', {
          sessionId: activeDemoSession.id,
          reason: 'booked',
        });
        ghl.addContactTags(parsed.contactId, [demoEndTag('booked')]).catch((e: unknown) =>
          console.error('[demo-session] booked tag failed (non-blocking):', e instanceof Error ? e.message : String(e)),
        );
        // Append the handover to this same reply: confirmation → pitch, no gap.
        reply = `${reply}\n\n${buildDemoEndAnnouncement(
          buildDemoHandoff(activeDemoSession.leadData, 'booked', true),
        )}`;
        endedByBooking = true;
        // Local role follows the DB so the follow-up cycle below re-arms (it is
        // suppressed only while the demo is running).
        activeRole = 'closer';
        console.log(`[demo-session] ended by booking conv=${parsed.conversationId}`);
      }
    } catch (e) {
      // Non-blocking: worst case the demo runs on to its message budget as before.
      console.error('[demo-session] booking check failed (non-blocking):', e instanceof Error ? e.message : String(e));
    }
  }

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
  // Demo guard: the truncated demo history re-opens the "opening exchanges" window, and
  // the name a lead roleplays with must never overwrite their real GHL contact name.
  const confirmContactName =
    activeRole !== 'demo' && !forcedReply &&
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
  // Demo guard: a demo conversation is roleplay — a fake customer's "ya no me interesa"
  // must not opt the REAL lead out (status + GHL tag + reactivation rules all real).
  const hasQuestion = reply.includes('?');
  console.log(`[classify] conv=${parsed.conversationId} hasQuestion=${hasQuestion}`);
  // Skipped for the forced handover too: it always ends in a question, and the lead's last
  // message was in-character roleplay — nothing there is a real terminal state.
  const outcome = activeRole === 'demo' || forcedReply || endedByBooking
    ? null
    : await classifyConversationOutcome(parsed.text, reply, aux);
  console.log(`[classify] outcome=${outcome ?? 'null (active or error)'}`);
  if (outcome) {
    try {
      // false = refused (0044): an `awaiting_human` lead can't be classified into
      // `standby`/`completed`. The classifier is a guess; the tag a person put on the
      // contact is not. Skip the tag mirror too — the state did not change.
      const applied = await updateConversationStatus(parsed.conversationId, outcome);
      console.log(`[conv] status→${outcome} conv=${parsed.conversationId} applied=${applied}`);
      // Meta CAPI (0048): a classifier-applied `completed` is a conversion signal for
      // tenants that opted the kind in. No-op otherwise; never throws.
      if (applied) {
        await queueCapiStatusEvent(tenant, parsed.conversationId, outcome);
      }
      // Mirror the state onto the GHL contact as a tag (transparency / sync).
      const tag = applied ? STATUS_TAGS[outcome] : undefined;
      if (tag && outcome === 'opted_out') {
        // AWAITED for this one status (0045). The tag stopped being decoration the
        // moment `opted_out` began muting the bot: removing it is now the operator's
        // only undo, so its ABSENCE is read as "this was a mistake". Written
        // fire-and-forget, a failed write would leave a muted lead with no tag — and
        // the next unrelated tag edit on that contact would silently un-mute someone
        // who had asked us to stop. Loud on failure for the same reason.
        try {
          await ghl.addContactTags(parsed.contactId, [tag]);
        } catch (e) {
          console.error(
            `[tags] OPT-OUT TAG WRITE FAILED contact=${parsed.contactId} — muted with no tag, a tag edit could lift it:`,
            e instanceof Error ? e.message : String(e),
          );
        }
      } else if (tag) {
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
  // Two ladders, never both. In demo the reactivation agent is persona-blind (full
  // history, tenant's normal config + angles) and its nudge would shatter the
  // roleplay — so the demo gets its own fixed, LLM-free reminders instead (0043).
  // Suppressing follow-ups outright, as this did before, left a lead who walked away
  // mid-demo unreachable forever: expiry is only evaluated on the next inbound.
  //
  // The demo rung is the number already DELIVERED, not this row's position: every
  // inbound cancels the pending nudge, so a lead who keeps playing never climbs, and
  // resetting to rung 1 would mean reminder #2 (how to close the demo) never lands.
  //
  // The demo ladder belongs to the SESSION funnel, which is why it is gated on one. A
  // manual keyword demo (§5b) has no session, no budget and no expiry: it is a live
  // showing, driven by whoever typed the keyword, and it ends when they type the exit
  // word. Nothing there can strand a lead — the stranding 0043 fixed comes from expiry
  // being evaluated only on the next inbound, which a manual demo has no concept of — so
  // there is nothing for a reminder to rescue, and a "(tu demo sigue activo)" line landing
  // half an hour after a live demo is just noise on a real prospect's thread. It gets
  // NEITHER ladder: falling through to the cadence would be worse than the reminders,
  // since the reactivation agent is persona-blind and would nudge from inside the roleplay.
  const inDemo = activeRole === 'demo';
  let firstDelay: number | undefined;
  let followUpKind: FollowUpKind = 'cadence';
  let followUpTier = 1;
  let followUpRound = 0;
  if (inDemo && !activeDemoSession) {
    // Manual keyword demo: no nudge of either kind (firstDelay stays undefined).
  } else if (inDemo) {
    followUpKind = 'demo';
    try {
      followUpTier = (await countSentDemoReminders(conversationId)) + 1;
      firstDelay = DEMO_REMINDER_CADENCE[followUpTier - 1];
    } catch (e) {
      console.error('[followup] demo rung read failed:', e instanceof Error ? e.message : String(e));
    }
  } else if (activeAppointment) {
    // Help mode (0049): a lead with an upcoming appointment is a customer being
    // assisted, not a lead being pursued — no nudge is armed. The bot still answers.
  } else if (reactivationRound < totalRounds(tenant.config)) {
    // Rounds (0049): each ghost cycle runs the cadence for the CURRENT round —
    // round 0 is the tenant's own ladder, later rounds taper. A lead past the last
    // round is never pursued again (only a real booking resets the counter).
    firstDelay = cadenceForRound(tenant.config, reactivationRound)[0];
    followUpRound = reactivationRound;
  }
  if (firstDelay !== undefined) {
    try {
      await scheduleFollowUp(
        conversationId, followUpTier, firstDelay,
        tenant.config.timezone, tenant.config.quietHours, followUpKind, followUpRound,
      );
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

  let { conversationId, messageId } = await logMessage({
    p_ghl_conversation_id: parsed.conversationId,
    p_client_id: tenant.clientId,
    p_channel: parsed.channel,
    p_ghl_contact_id: parsed.contactId,
    p_contact_phone: phone ?? null,
    p_direction: 'inbound',
    p_sender_type: 'lead',
    // A media-only message has empty text; store a placeholder so history is never a
    // blank turn (loadRecentMessages drops empty content). Audio gets replaced with the
    // real transcription at turn time.
    p_content: parsed.text || placeholderFor(parsed.attachments),
    p_agent_role: null,
    p_human_agent_id: null,
    p_model: null,
    p_sent_at: null,
    p_ghl_message_id: parsed.messageId ?? null,
    p_attachments: parsed.attachments.length > 0 ? parsed.attachments.map((a) => a.url) : null,
  });
  if (!conversationId) {
    // GHL retried a webhook we already stored. Normally that's a harmless duplicate —
    // but it is ALSO what happens when our first attempt persisted the inbound and then
    // died before scheduling the turn. Dedup would turn that transient failure into
    // permanent silence for a real lead (observed 2026-07-30 on a Facebook thread: the
    // message was stored, zero events followed, the bot never answered). So: if the
    // conversation's last message is still an unanswered lead message, recover by
    // running the turn instead of dropping it.
    const pending = await findUnansweredInbound(parsed.conversationId).catch((e: unknown) => {
      console.error('[dedup] recovery check failed:', e instanceof Error ? e.message : String(e));
      return null;
    });
    if (!pending) {
      return { status: 200, body: { ignored: 'duplicate message', messageId: parsed.messageId } };
    }
    console.log(`[dedup] recovering unanswered inbound conv=${parsed.conversationId}`);
    conversationId = pending.conversationId;
    messageId = pending.messageId;
    await logBotEvent(tenant.clientId, parsed.conversationId, 'turn_scheduled', {
      via: 'duplicate-recovery',
    });
    // Fall through: the normal gates + scheduling below now run for this turn.
  }

  // Persist the contact's email as a merge key (phone already went in via logMessage above)
  // so a later send can re-resolve a merged-away contact. Fire-and-forget; non-blocking.
  if (inboundEmail) {
    setConversationContactKeys(parsed.conversationId, { email: inboundEmail }).catch((e: unknown) =>
      console.error('[merge-keys] inbound persist failed (non-blocking):', e instanceof Error ? e.message : String(e)),
    );
  }

  // Cancel any pending follow-ups — the lead is back. AWAITED (0043): this is one
  // half of the send race. The runner's commit gate refuses to send a row that is no
  // longer 'processing', so the sooner this lands the more often the cheap check
  // catches it; fire-and-forget could let a nudge slip out after the lead replied.
  await cancelFollowUps(conversationId).catch((e: unknown) => {
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
    // This RPC is the last awaited DB call before the turn is scheduled, and it used to be
    // unprotected: a transient failure here threw, the route 500'd, and GHL's retry hit the
    // dedup branch — a lead silently lost. Fail OPEN on error (answering one message we
    // might have gated beats dropping a real lead) and make the degradation visible.
    let state: Awaited<ReturnType<typeof botActivation>>;
    try {
      state = await botActivation(conversationId, matched);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[gate] botActivation failed — failing open:', msg);
      await logBotEvent(tenant.clientId, parsed.conversationId, 'db_error', {
        stage: 'bot_activation',
        error: msg,
        failedOpen: true,
      });
      state = 'already';
    }
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
      // A running SESSION must be ended here too — not just the persona flip —
      // or it stays orphaned-active: no demo_session_ended event, no funnel tag,
      // and the budget meter would resume if demo mode were ever re-entered.
      const session = await getActiveDemoSession(parsed.conversationId).catch(() => null);
      if (session) {
        await endDemoSession(session.id, 'closed'); // also flips active_role → NULL
        await logBotEvent(tenant.clientId, parsed.conversationId, 'demo_session_ended', {
          sessionId: session.id,
          reason: 'closed',
        });
        new GhlClient(tenant.tenantId).addContactTags(parsed.contactId, [demoEndTag('closed')]).catch((e: unknown) =>
          console.error('[demo] close tag failed (non-blocking):', e instanceof Error ? e.message : String(e)),
        );
      } else {
        await setActiveRole(parsed.conversationId, null);
      }
      await logBotEvent(tenant.clientId, parsed.conversationId, 'demo_toggled', { to: 'front-desk' });
    } catch (e) {
      console.error('[demo] setActiveRole(null) failed:', e instanceof Error ? e.message : String(e));
    }
  }

  const runParams: AgentRunParams = { agent, conversationId, messageId, tenant, parsed, phone, debounced: true };

  // Durable-turn path (flagged rollout): hand the turn to the conversation's DO, which
  // debounces via a durable Alarm and runs it serialized — no waitUntil drop, no double-run.
  //
  // The DO call is NOT awaited inside the request. The inbound is already stored; nothing
  // GHL needs is pending. Awaiting here put DO latency on GHL's ~10 s webhook timeout: on
  // 2026-08-27 a `scheduleTurn` stalled for 10 s (Cloudflare-side — the DO was idle and the
  // call is two storage ops), GHL hung up, the request and its RPC were CANCELED, and no
  // turn was ever scheduled. `waitUntil` survives the client disconnecting, so the schedule
  // completes even if GHL has already given up. The `turn_scheduled` event and the legacy
  // fallback both live inside the same promise — a failure still degrades to an in-request
  // turn instead of silence.
  if (doNamespace && ctx && doTurnsEnabled(tenant)) {
    ctx.waitUntil(scheduleOnDurableObject(doNamespace, runParams).catch((err) => {
      console.error('[DO] scheduling chain failed:', err instanceof Error ? err.message : String(err));
    }));
    return { status: 200, body: { scheduled: 'durable-object', conversationId } };
  }

  if (ctx) {
    ctx.waitUntil(
      new Promise<void>((resolve) => setTimeout(resolve, DEBOUNCE_MS))
        .then(() => runAgentTurn(runParams))
        .catch((err) => {
          console.error('[debounce] unhandled error:', err instanceof Error ? err.message : String(err));
        }),
    );
    // Same event as the DO path, for the same reader: the dedup recovery decides whether a
    // GHL retry may re-run the turn by whether this event exists — without it, a retry
    // landing during the debounce would run the turn twice.
    await logBotEvent(tenant.clientId, parsed.conversationId, 'turn_scheduled', { via: 'wait-until' });
    console.log(`[debounce] scheduled conv=${parsed.conversationId} delay=${DEBOUNCE_MS}ms`);
    return { status: 200, body: { debounced: true, conversationId } };
  }

  // Sync fallback: no CF execution context (test / non-CF environments).
  // Skip the debounce gate since there's no concurrent handler to race against.
  return runAgentTurn({ ...runParams, debounced: false });
}
