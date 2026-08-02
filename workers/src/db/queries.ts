/**
 * Typed DB access for the agent runtime.
 *
 * Reads: tenant config + conversation history (our store, not GHL).
 * Writes: the existing app_log_* RPCs (app_log_message recreated in 0005;
 *         the rest unchanged).
 */

import { getSupabase } from './client.js';
import type { AiProvider, Channel, ConversationMessage, ConversationStatus, FollowUpKind, QuietHours, TenantContext } from '../core/types.js';
import { DEMO_REMINDER_ROLE } from '../core/types.js';
import { clampToActiveHours, DEFAULT_QUIET_HOURS } from '../core/active-hours.js';
import type { TokenUsage } from '../core/llm-usage.js';
import { isAppointmentActive } from './appointment-active.js';
import { parseMetaCapi } from '../meta/capi-config.js';
import type { GhlTokenResponse } from '../ghl/oauth.js';
import type {
  BotEventType,
  DueFollowUp,
  EnqueueCapiEventParams,
  LogAppointmentParams,
  LogEventParams,
  LogMessageParams,
  LogMessageResult,
  MessageRow,
  OAuthTokenRow,
  PendingCapiEvent,
  PendingDelivery,
  TenantConfigRow,
  TenantRow,
  UpsertHumanAgentParams,
} from './types.js';

function fail(scope: string, error: { message: string } | null): void {
  if (error) {
    throw new Error(`[db:${scope}] ${error.message}`);
  }
}

/**
 * Resolve a tenant + its config from the GHL location id. Joins from
 * tenant_config up to its (one-to-one) tenants row. Returns null when the
 * location is unknown or the tenant is inactive.
 */
export async function loadTenantConfig(ghlLocationId: string): Promise<TenantContext | null> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('tenant_config')
    .select(
      'business_name, timezone, tone, services, hours, calendars, faq, enabled_roles, prompt_overrides, ai_provider, ai_model, ai_key_ref, awaiting_human_tag, follow_up_tiers, follow_up_cadence, follow_up_angles, quiet_hours, booking_horizon_days, enabled_channels, test_contact_ids, trigger_keywords, demo_on_keywords, demo_off_keywords, demo_prompt_overrides, keyword_variants, prompt_variants, demo_sessions_enabled, meta_capi,' +
        'tenants!inner(id, client_id, ghl_location_id, is_active)',
    )
    .eq('tenants.ghl_location_id', ghlLocationId)
    .eq('tenants.is_active', true)
    .maybeSingle();
  fail('loadTenantConfig', error);
  if (!data) return null;

  const row = data as unknown as TenantConfigRow & { tenants: TenantRow };
  const t = row.tenants;
  const validChannels: Channel[] = ['whatsapp', 'instagram', 'facebook'];
  return {
    tenantId: t.id,
    clientId: t.client_id,
    ghlLocationId: t.ghl_location_id,
    enabledRoles: row.enabled_roles ?? [],
    // null stays null (silent); otherwise keep only recognized channels.
    enabledChannels: row.enabled_channels
      ? row.enabled_channels.filter((c): c is Channel => validChannels.includes(c as Channel))
      : null,
    testContactIds: row.test_contact_ids ?? null,
    triggerKeywords: row.trigger_keywords ?? null,
    demoOnKeywords: row.demo_on_keywords ?? null,
    demoOffKeywords: row.demo_off_keywords ?? null,
    keywordVariants: parseKeywordVariants(row.keyword_variants),
    awaitingHumanTag: row.awaiting_human_tag?.trim() ? row.awaiting_human_tag.trim() : null,
    demoSessionsEnabled: row.demo_sessions_enabled === true,
    metaCapi: parseMetaCapi(row.meta_capi),
    config: {
      businessName: row.business_name,
      timezone: row.timezone,
      tone: row.tone,
      services: row.services,
      hours: row.hours,
      calendars: row.calendars,
      faq: row.faq,
      promptOverrides: row.prompt_overrides,
      demoPromptOverrides: row.demo_prompt_overrides ?? null,
      promptVariants: row.prompt_variants ?? null,
      provider: (row.ai_provider as AiProvider) ?? undefined,
      model: row.ai_model ?? undefined,
      followUpCadence: Array.isArray(row.follow_up_cadence)
        ? (row.follow_up_cadence as unknown[]).filter((n): n is number => typeof n === 'number' && n > 0)
        : null,
      followUpAngles: Array.isArray(row.follow_up_angles)
        ? (row.follow_up_angles as unknown[]).filter((s): s is string => typeof s === 'string' && s.length > 0)
        : null,
      quietHours: parseQuietHours(row.quiet_hours),
      bookingHorizonDays:
        typeof row.booking_horizon_days === 'number' && row.booking_horizon_days > 0
          ? row.booking_horizon_days
          : null,
      aiKeyRef: row.ai_key_ref?.trim() ? row.ai_key_ref.trim() : null,
    },
  };
}

/** The GHL location id for a tenant. Used by contact-merge recovery (which searches
 *  contacts within a location) when only the tenantId is in scope. Returns undefined if
 *  the tenant is unknown. */
export async function getTenantGhlLocationId(tenantId: string): Promise<string | undefined> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('tenants')
    .select('ghl_location_id')
    .eq('id', tenantId)
    .maybeSingle();
  fail('getTenantGhlLocationId', error);
  return (data as { ghl_location_id?: string } | null)?.ghl_location_id ?? undefined;
}

/** Sanitize keyword_variants jsonb: keep only non-empty string→string entries; anything else → null. */
function parseKeywordVariants(raw: unknown): Record<string, string> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (k.trim().length > 0 && typeof v === 'string' && v.trim().length > 0) out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** Validate the stored quiet_hours jsonb; anything malformed falls back to null (platform default). */
function parseQuietHours(raw: unknown): QuietHours | null {
  if (!raw || typeof raw !== 'object') return null;
  const { start, end } = raw as { start?: unknown; end?: unknown };
  const valid = (h: unknown): h is number => typeof h === 'number' && Number.isInteger(h) && h >= 0 && h <= 23;
  return valid(start) && valid(end) ? { start, end } : null;
}

/**
 * Load the most recent messages for a conversation (chronological order) from
 * OUR store, to rebuild the agent's history. Empty-content rows are skipped.
 * `sinceTs` (ISO) restricts to messages at/after that time — used for a clean
 * demo start so the persona doesn't inherit pre-demo history.
 */
export async function loadRecentMessages(
  conversationId: string,
  limit = 20,
  sinceTs?: string,
): Promise<ConversationMessage[]> {
  const supabase = getSupabase();
  let query = supabase
    .from('messages')
    .select('direction, sender_type, content, agent_role, human_agent_id, model, sent_at')
    .eq('conversation_id', conversationId);
  if (sinceTs) query = query.gte('sent_at', sinceTs);
  const { data, error } = await query.order('sent_at', { ascending: false }).limit(limit);
  fail('loadRecentMessages', error);

  const rows = (data ?? []) as MessageRow[];
  return rows
    .reverse()
    .filter((r) => (r.content ?? '').length > 0)
    .map((r) => ({
      direction: r.direction,
      senderType: r.sender_type,
      content: r.content ?? '',
      agentRole: r.agent_role ?? undefined,
      humanAgentId: r.human_agent_id ?? undefined,
      model: r.model ?? undefined,
      sentAt: r.sent_at,
    }));
}

/**
 * Upsert the conversation + insert one message.
 * Returns null conversationId/messageId when an inbound message with the same
 * ghl_message_id was already processed (duplicate webhook) — callers must abort.
 * Outbound bot messages get delivery_status='pending'; messageId is needed for
 * markDelivered() once GHL confirms receipt.
 */
export async function logMessage(params: LogMessageParams): Promise<LogMessageResult> {
  const supabase = getSupabase();
  const { data, error } = await supabase.rpc('app_log_message', params);
  fail('logMessage', error);
  const result = data as { conversation_id: string; message_id: string } | null;
  return {
    conversationId: result?.conversation_id ?? null,
    messageId: result?.message_id ?? null,
  };
}

/** Mark an outbound bot message as delivered. Fire-and-forget safe. */
export async function markDelivered(messageId: string): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase.rpc('app_mark_delivered', { p_message_id: messageId });
  fail('markDelivered', error);
}

/** The conversation's persona: active role + when the CURRENT persona took over
 *  (clean-start history for demo AND for the closer after a demo ends) + the
 *  campaign prompt variant pinned at activation (first-touch sticky). */
export interface ConversationPersona {
  activeRole: string | null;
  /** When the current persona took over (0038). null = no persona change ever. */
  roleStartedAt: string | null;
  /** Legacy demo-only stamp (0029); read as a fallback for rows written pre-0038. */
  demoStartedAt: string | null;
  promptVariant: string | null;
}

/** Read the conversation's persona (null activeRole = normal front-desk; 'demo' = demo persona). */
export async function getConversationPersona(conversationId: string): Promise<ConversationPersona> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('conversations')
    .select('active_role, role_started_at, demo_started_at, prompt_variant')
    .eq('id', conversationId)
    .maybeSingle();
  fail('getConversationPersona', error);
  const row = data as {
    active_role: string | null;
    role_started_at: string | null;
    demo_started_at: string | null;
    prompt_variant: string | null;
  } | null;
  return {
    activeRole: row?.active_role ?? null,
    roleStartedAt: row?.role_started_at ?? null,
    demoStartedAt: row?.demo_started_at ?? null,
    promptVariant: row?.prompt_variant ?? null,
  };
}

// ── Demo sessions (0038): budgeted per-lead self-demos (the lead-magnet funnel) ──

/** A demo session's simulated (never-real) booking. */
export interface SimulatedBooking {
  startTime: string;
  serviceName: string;
  label: string;
}

export interface ActiveDemoSession {
  id: string;
  activatedAt: string;
  expiresAt: string;
  messageBudget: number;
  personaVersion: number;
  leadData: Record<string, unknown>;
  /** The generated persona, overlaid onto demoPromptOverrides at turn time. */
  promptOverrides: unknown;
  simulatedBooking: SimulatedBooking | null;
}

/** The conversation's most recent demo session whatever its status — the closer
 *  persona rebuilds its handoff context from this on every post-demo turn. */
export async function getLatestDemoSession(
  ghlConversationId: string,
): Promise<{
  leadData: Record<string, unknown>;
  endReason: string | null;
  endedAt: string | null;
  booked: boolean;
} | null> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('demo_sessions')
    .select('lead_data, end_reason, ended_at, simulated_booking')
    .eq('ghl_conversation_id', ghlConversationId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  fail('getLatestDemoSession', error);
  if (!data) return null;
  const row = data as {
    lead_data: Record<string, unknown> | null;
    end_reason: string | null;
    ended_at: string | null;
    simulated_booking: unknown;
  };
  return {
    leadData: row.lead_data ?? {},
    endReason: row.end_reason,
    endedAt: row.ended_at,
    booked: row.simulated_booking != null,
  };
}

/** The conversation's ACTIVE demo session, or null (manual keyword demos have none). */
export async function getActiveDemoSession(ghlConversationId: string): Promise<ActiveDemoSession | null> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('demo_sessions')
    .select('id, activated_at, expires_at, message_budget, persona_version, lead_data, prompt_overrides, simulated_booking')
    .eq('ghl_conversation_id', ghlConversationId)
    .eq('status', 'active')
    .maybeSingle();
  fail('getActiveDemoSession', error);
  if (!data) return null;
  const row = data as {
    id: string;
    activated_at: string;
    expires_at: string;
    message_budget: number;
    persona_version: number;
    lead_data: Record<string, unknown> | null;
    prompt_overrides: unknown;
    simulated_booking: SimulatedBooking | null;
  };
  return {
    id: row.id,
    activatedAt: row.activated_at,
    expiresAt: row.expires_at,
    messageBudget: row.message_budget,
    personaVersion: row.persona_version,
    leadData: row.lead_data ?? {},
    promptOverrides: row.prompt_overrides,
    simulatedBooking: row.simulated_booking ?? null,
  };
}

/** Create a session + flip the conversation into demo, atomically (app_create_demo_session).
 *  A running session is replaced, not errored. Returns the new session id. */
export async function createDemoSession(params: {
  ghlConversationId: string;
  leadData: Record<string, unknown>;
  promptOverrides: unknown;
  messageBudget: number;
  expiresMinutes: number;
  personaVersion?: number;
}): Promise<string> {
  const supabase = getSupabase();
  const { data, error } = await supabase.rpc('app_create_demo_session', {
    p_ghl_conversation_id: params.ghlConversationId,
    p_lead_data: params.leadData,
    p_prompt_overrides: params.promptOverrides,
    p_message_budget: params.messageBudget,
    p_expires_minutes: params.expiresMinutes,
    p_persona_version: params.personaVersion ?? 1,
  });
  fail('createDemoSession', error);
  if (typeof data !== 'string') throw new Error('[db:createDemoSession] RPC returned no session id');
  return data;
}

/** End a session + flip the conversation back to the normal persona, atomically. */
export async function endDemoSession(
  sessionId: string,
  reason: 'exhausted' | 'expired' | 'closed' | 'booked',
): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase.rpc('app_end_demo_session', {
    p_session_id: sessionId,
    p_reason: reason,
  });
  fail('endDemoSession', error);
}

/** Bot messages logged since a timestamp — the demo budget meter (counts the
 *  message PARTS the lead actually received; self-healing, no counter drift). */
export async function countBotMessagesSince(conversationId: string, sinceTs: string): Promise<number> {
  const supabase = getSupabase();
  const { count, error } = await supabase
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('conversation_id', conversationId)
    .eq('sender_type', 'bot')
    .gte('sent_at', sinceTs)
    // Demo reminders are OUR bookkeeping, not the demo talking, and the budget is
    // only 7 messages — counting three reminders against it would silently cost the
    // lead almost half of what they came to see. `.or` rather than `.neq` because a
    // PostgREST neq also drops NULL agent_role rows, which are real demo replies.
    .or(`agent_role.is.null,agent_role.neq.${DEMO_REMINDER_ROLE}`);
  fail('countBotMessagesSince', error);
  return count ?? 0;
}

/**
 * The conversation's last message when it is an UNANSWERED lead message older than
 * `minAgeSeconds` — i.e. we stored the inbound and never replied.
 *
 * Used to recover from GHL's webhook retry: if our first attempt died after persisting
 * the inbound, the retry would otherwise be swallowed by dedup and the lead would go
 * permanently silent. The age floor keeps a genuinely concurrent duplicate (retry while
 * the first turn is still generating) from producing a second reply.
 */
export async function findUnansweredInbound(
  ghlConversationId: string,
  minAgeSeconds = 60,
): Promise<{ conversationId: string; messageId: string } | null> {
  const supabase = getSupabase();
  const { data: conv, error: convErr } = await supabase
    .from('conversations')
    .select('id')
    .eq('ghl_conversation_id', ghlConversationId)
    .maybeSingle();
  fail('findUnansweredInbound:conversation', convErr);
  const conversationId = (conv as { id?: string } | null)?.id;
  if (!conversationId) return null;

  const { data, error } = await supabase
    .from('messages')
    .select('id, sender_type, sent_at')
    .eq('conversation_id', conversationId)
    .order('sent_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  fail('findUnansweredInbound:message', error);
  const row = data as { id: string; sender_type: string; sent_at: string } | null;
  if (!row || row.sender_type !== 'lead') return null;
  if (Date.now() - Date.parse(row.sent_at) < minAgeSeconds * 1000) return null;
  return { conversationId, messageId: row.id };
}

/** Timestamp of the first inbound after `afterTs` (the demo budget's real start: the
 *  lead's first in-character message, so the startDemo announcement isn't charged). */
export async function firstInboundAfter(conversationId: string, afterTs: string): Promise<string | null> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('messages')
    .select('sent_at')
    .eq('conversation_id', conversationId)
    .eq('direction', 'inbound')
    .gt('sent_at', afterTs)
    .order('sent_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  fail('firstInboundAfter', error);
  return (data as { sent_at?: string } | null)?.sent_at ?? null;
}

/** Store/clear the session's simulated booking (demo bookings never touch GHL). */
export async function setSimulatedBooking(sessionId: string, booking: SimulatedBooking | null): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase
    .from('demo_sessions')
    .update({ simulated_booking: booking })
    .eq('id', sessionId);
  fail('setSimulatedBooking', error);
}

/**
 * First-touch sticky variant assignment (app_set_prompt_variant). Returns true
 * only when THIS call pinned the variant — callers log variant_assigned then.
 * Re-matches on an already-pinned conversation are no-ops (false).
 */
export async function setPromptVariant(ghlConversationId: string, variant: string): Promise<boolean> {
  const supabase = getSupabase();
  const { data, error } = await supabase.rpc('app_set_prompt_variant', {
    p_ghl_conversation_id: ghlConversationId,
    p_variant: variant,
  });
  fail('setPromptVariant', error);
  return data === true;
}

/** Persist a corrected GHL contact id on a conversation (after a merge re-resolve on send). */
export async function updateConversationContact(ghlConversationId: string, ghlContactId: string): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase
    .from('conversations')
    .update({ ghl_contact_id: ghlContactId })
    .eq('ghl_conversation_id', ghlConversationId);
  fail('updateConversationContact', error);
}

/** Persist the contact's merge keys (phone/email) on a conversation so a later send can
 *  re-resolve a merged-away contact. Only writes keys that are provided and non-empty —
 *  never clobbers a stored value with null. No-op when nothing to write. */
export async function setConversationContactKeys(
  ghlConversationId: string,
  keys: { phone?: string | null; email?: string | null },
): Promise<void> {
  const patch: { contact_phone?: string; contact_email?: string } = {};
  if (keys.phone) patch.contact_phone = keys.phone;
  if (keys.email) patch.contact_email = keys.email;
  if (Object.keys(patch).length === 0) return;
  const supabase = getSupabase();
  const { error } = await supabase
    .from('conversations')
    .update(patch)
    .eq('ghl_conversation_id', ghlConversationId);
  fail('setConversationContactKeys', error);
}

/** Read a conversation's stored contact merge keys (phone/email). Both may be null. */
export async function getConversationContactKeys(
  ghlConversationId: string,
): Promise<{ phone: string | null; email: string | null }> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('conversations')
    .select('contact_phone, contact_email')
    .eq('ghl_conversation_id', ghlConversationId)
    .maybeSingle();
  fail('getConversationContactKeys', error);
  const row = data as { contact_phone: string | null; contact_email: string | null } | null;
  return { phone: row?.contact_phone ?? null, email: row?.contact_email ?? null };
}

/**
 * Persist the Meta ad attribution captured from the GHL contact (0048).
 * First-touch sticky: only writes while ctwa_clid is still NULL, so a
 * re-capture on turn 2 (or a later ad click) never rewrites which click
 * gets credited. Fire-and-forget safe.
 */
export async function setConversationAttribution(
  ghlConversationId: string,
  args: { ctwaClid: string; attribution: unknown },
): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase
    .from('conversations')
    .update({ ctwa_clid: args.ctwaClid, attribution: args.attribution ?? null })
    .eq('ghl_conversation_id', ghlConversationId)
    .is('ctwa_clid', null);
  fail('setConversationAttribution', error);
}

/** The conversation's stored CTWA click id; null when the lead didn't come from a CTWA ad. */
export async function getConversationCtwaClid(ghlConversationId: string): Promise<string | null> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('conversations')
    .select('ctwa_clid')
    .eq('ghl_conversation_id', ghlConversationId)
    .maybeSingle();
  fail('getConversationCtwaClid', error);
  return (data as { ctwa_clid: string | null } | null)?.ctwa_clid ?? null;
}

/** Switch a conversation's persona. Pass null to return it to the normal front-desk agent. */
export async function setActiveRole(ghlConversationId: string, activeRole: string | null): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase.rpc('app_set_active_role', {
    p_ghl_conversation_id: ghlConversationId,
    p_active_role: activeRole,
  });
  fail('setActiveRole', error);
}

/**
 * Store the GHL-assigned message ID on a bot outbound message.
 * Called right after sendMessage() returns so the outbound webhook echo
 * can be identified and ignored by isBotMessageById().
 */
export async function setGhlMessageId(messageId: string, ghlMessageId: string): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase
    .from('messages')
    .update({ ghl_message_id: ghlMessageId })
    .eq('id', messageId);
  fail('setGhlMessageId', error);
}

/**
 * Replace a message's content (0046). Used to swap the "[nota de voz]" placeholder for
 * the real transcription, so every later turn reads plain text instead of a marker.
 */
export async function setMessageContent(messageId: string, content: string): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase.rpc('app_set_message_content', {
    p_message_id: messageId,
    p_content: content,
  });
  fail('setMessageContent', error);
}

/** Mark an outbound bot message as permanently failed (retries exhausted). */
export async function markDeliveryFailed(messageId: string): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase.rpc('app_mark_delivery_failed', { p_message_id: messageId });
  fail('markDeliveryFailed', error);
}

/** Increment the retry counter for a message before each cron retry attempt. */
export async function incrementRetryCount(messageId: string): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase.rpc('app_increment_retry_count', { p_message_id: messageId });
  fail('incrementRetryCount', error);
}

/** Load outbound bot messages pending delivery (>30s old, <3 cron retries). */
export async function loadPendingDeliveries(limit = 20): Promise<PendingDelivery[]> {
  const supabase = getSupabase();
  const { data, error } = await supabase.rpc('app_load_pending_deliveries', { p_limit: limit });
  fail('loadPendingDeliveries', error);
  type Row = {
    message_id: string;
    content: string;
    channel: string;
    ghl_conversation_id: string;
    ghl_contact_id: string;
    contact_phone: string | null;
    tenant_id: string;
    retry_count: number;
  };
  return ((data ?? []) as Row[]).map((r) => ({
    messageId: r.message_id,
    content: r.content,
    channel: r.channel,
    ghlConversationId: r.ghl_conversation_id,
    ghlContactId: r.ghl_contact_id,
    contactPhone: r.contact_phone,
    tenantId: r.tenant_id,
    retryCount: r.retry_count,
  }));
}

/** Idempotent CAPI enqueue (0048). Returns true only when THIS call inserted the row. */
export async function enqueueCapiEvent(params: EnqueueCapiEventParams): Promise<boolean> {
  const supabase = getSupabase();
  const { data, error } = await supabase.rpc('app_enqueue_capi_event', params);
  fail('enqueueCapiEvent', error);
  return data === true;
}

/** Pending CAPI events (attempts < 3), oldest first, with each tenant's LIVE meta_capi. */
export async function loadPendingCapiEvents(limit = 20): Promise<PendingCapiEvent[]> {
  const supabase = getSupabase();
  const { data, error } = await supabase.rpc('app_load_pending_capi_events', { p_limit: limit });
  fail('loadPendingCapiEvents', error);
  type Row = {
    id: string;
    client_id: string;
    ghl_conversation_id: string;
    kind: string;
    event_name: string;
    event_id: string;
    event_time: string;
    payload: PendingCapiEvent['payload'];
    attempts: number;
    last_error: string | null;
    created_at: string;
    tenant_id: string;
    meta_capi: unknown;
  };
  return ((data ?? []) as Row[]).map((r) => ({
    id: r.id,
    clientId: r.client_id,
    ghlConversationId: r.ghl_conversation_id,
    kind: r.kind,
    eventName: r.event_name,
    eventId: r.event_id,
    eventTime: r.event_time,
    payload: r.payload,
    attempts: r.attempts,
    lastError: r.last_error,
    createdAt: r.created_at,
    tenantId: r.tenant_id,
    metaCapi: r.meta_capi,
  }));
}

/** Transition a CAPI queue row; 'pending' + an error parks it with a diagnostic (logged once). */
export async function markCapiEvent(
  id: string,
  status: 'pending' | 'sent' | 'failed',
  errorMsg: string | null = null,
): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase.rpc('app_mark_capi_event', {
    p_id: id,
    p_status: status,
    p_error: errorMsg,
  });
  fail('markCapiEvent', error);
}

/** Increment a CAPI row's attempt counter before each send attempt. */
export async function incrementCapiAttempts(id: string): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase.rpc('app_increment_capi_attempts', { p_id: id });
  fail('incrementCapiAttempts', error);
}

/** Record an appointment action (booked / rescheduled / cancelled). Returns appt uuid. */
export async function logAppointment(params: LogAppointmentParams): Promise<{ appointmentId: string }> {
  const supabase = getSupabase();
  const { data, error } = await supabase.rpc('app_log_appointment', params);
  fail('logAppointment', error);
  return { appointmentId: data as string };
}

/** The contact's most recent appointment (any action), for reschedule/cancel. */
export interface LatestAppointment {
  ghlAppointmentId: string;
  appointmentDatetime: string | null;
  serviceType: string | null;
  action: 'booked' | 'rescheduled' | 'cancelled';
}

/**
 * Load the contact's most recent appointment row (joined via its conversation).
 * Returns null when there is none or the newest row has no GHL id. Callers treat
 * a newest action of 'cancelled' as "no active appointment".
 */
export async function loadLatestAppointment(
  clientId: string,
  ghlContactId: string,
): Promise<LatestAppointment | null> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('appointments')
    .select('ghl_appointment_id, appointment_datetime, service_type, action, conversations!inner(ghl_contact_id)')
    .eq('client_id', clientId)
    .eq('conversations.ghl_contact_id', ghlContactId)
    .not('ghl_appointment_id', 'is', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  fail('loadLatestAppointment', error);
  if (!data) return null;
  const row = data as unknown as {
    ghl_appointment_id: string;
    appointment_datetime: string | null;
    service_type: string | null;
    action: 'booked' | 'rescheduled' | 'cancelled';
  };
  return {
    ghlAppointmentId: row.ghl_appointment_id,
    appointmentDatetime: row.appointment_datetime,
    serviceType: row.service_type,
    action: row.action,
  };
}

/**
 * The contact's active (not cancelled, not past) appointment, if any — deterministic
 * turn-start guard input so the agent knows it already has a booking and never re-checks
 * availability against its own just-created appointment (the self-block class).
 * Reads our store only (fresh in the exact self-block scenario); GHL truth still governs
 * reschedule/cancel. Returns null when there is no active appointment.
 */
export async function loadActiveAppointment(
  clientId: string,
  ghlContactId: string,
): Promise<{ startTime: string; service: string | null } | null> {
  const appt = await loadLatestAppointment(clientId, ghlContactId);
  if (!isAppointmentActive(appt, Date.now())) return null;
  // isAppointmentActive guarantees appt and appointmentDatetime are non-null here.
  return { startTime: appt!.appointmentDatetime!, service: appt!.serviceType };
}

/** Record a value event (lead_qualified, out_of_hours_handled, …). Returns event uuid. */
export async function logEvent(params: LogEventParams): Promise<{ eventId: string }> {
  const supabase = getSupabase();
  const { data, error } = await supabase.rpc('app_log_event', params);
  fail('logEvent', error);
  return { eventId: data as string };
}

/**
 * Fire-and-forget token accounting — one row per model call, never throws.
 *
 * This is what answers "how much does each client cost us": the provider
 * dashboard only gives coarse daily totals per project, while these rows give
 * cost per conversation, per role and per lead. Failures are swallowed on
 * purpose — losing a usage row is a reporting gap, blocking a turn is an outage.
 */
export async function logLlmUsage(params: {
  clientId: string;
  ghlConversationId: string | null;
  callKind: string;
  provider: AiProvider;
  model: string;
  usage: TokenUsage;
  keySource: string;
}): Promise<void> {
  try {
    const supabase = getSupabase();
    const { error } = await supabase.rpc('app_log_llm_usage', {
      p_client_id: params.clientId,
      p_ghl_conversation_id: params.ghlConversationId,
      p_call_kind: params.callKind,
      p_provider: params.provider,
      p_model: params.model,
      p_input_tokens: params.usage.inputTokens,
      p_output_tokens: params.usage.outputTokens,
      p_cached_input_tokens: params.usage.cachedInputTokens,
      p_key_source: params.keySource,
    });
    fail('logLlmUsage', error);
  } catch (err) {
    console.error('[logLlmUsage] failed:', err instanceof Error ? err.message : String(err));
  }
}

/**
 * Fire-and-forget error logger — writes to bot_events, never throws.
 * Use in catch blocks so observability failures never mask the original error.
 */
export function logError(
  clientId: string,
  ghlConversationId: string,
  type: 'agent_error' | 'delivery_error' | 'db_error',
  metadata: Record<string, unknown>,
): void {
  logEvent({
    p_client_id: clientId,
    p_ghl_conversation_id: ghlConversationId,
    p_event_type: type,
    p_metadata: metadata,
  }).catch((err) => {
    console.error('[logError] failed to write error event:', err instanceof Error ? err.message : String(err));
  });
}

/** Mark a conversation as handed off to a human (pauses the AI for that thread). */
export async function setHandoff(ghlConversationId: string): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase.rpc('app_set_handoff', {
    p_ghl_conversation_id: ghlConversationId,
  });
  fail('setHandoff', error);
}

/**
 * Tag-driven kill switch: set (off=true) or clear (off=false) handed_off for
 * every conversation belonging to a GHL contact. Contact-scoped because the
 * GHL ContactTagUpdate webhook carries no conversationId. Returns the number of
 * conversations whose status actually changed.
 */
export async function setBotOffByContact(ghlContactId: string, off: boolean): Promise<number> {
  const supabase = getSupabase();
  const { data, error } = await supabase.rpc('app_set_bot_off_by_contact', {
    p_ghl_contact_id: ghlContactId,
    p_off: off,
  });
  fail('setBotOffByContact', error);
  return (data as number | null) ?? 0;
}

/**
 * Contact-scoped awaiting-human toggle, driven by the tenant's GHL tag.
 *
 * Mirrors `setBotOffByContact`: the tag is the operational source of truth, so the
 * person clearing it — the real "I've handled this" action — is what returns the
 * conversation to `active` and makes follow-ups available again. Returns how many
 * conversations changed (0 when it was already in that state, so the bot adding the
 * tag itself doesn't loop). Never overrides handed_off or opted_out: stronger signals.
 */
export async function setAwaitingHumanByContact(
  ghlContactId: string,
  awaiting: boolean,
): Promise<number> {
  const supabase = getSupabase();
  const { data, error } = await supabase.rpc('app_set_awaiting_human_by_contact', {
    p_ghl_contact_id: ghlContactId,
    p_awaiting: awaiting,
  });
  fail('setAwaitingHumanByContact', error);
  return (data as number | null) ?? 0;
}

/**
 * Undo an opt-out for a contact (0045). Clear-only: there is no `set` direction,
 * because adding the tag must never opt anyone out — the lead and the classifier
 * own that call, an operator only owns reversing a wrong one.
 *
 * Returns how many conversations changed; 0 when there was nothing opted out,
 * which is what keeps the bot's own tag write from looping (this only ever runs
 * on the tag's ABSENCE). Rows in `handed_off` are untouched — stronger signal.
 */
export async function clearOptedOutByContact(ghlContactId: string): Promise<number> {
  const supabase = getSupabase();
  const { data, error } = await supabase.rpc('app_clear_opted_out_by_contact', {
    p_ghl_contact_id: ghlContactId,
  });
  fail('clearOptedOutByContact', error);
  return (data as number | null) ?? 0;
}

/**
 * Observability event (run outcome, suppression, …). Never throws — swallows its
 * own errors. AWAIT it in request handlers: on Cloudflare a detached promise is
 * killed once the response is sent (no waitUntil in the route), so fire-and-forget
 * would silently drop the event.
 * Pass an empty ghlConversationId for contact-level events with no conversation.
 */
export async function logBotEvent(
  clientId: string,
  ghlConversationId: string,
  eventType: BotEventType,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  try {
    await logEvent({
      p_client_id: clientId,
      p_ghl_conversation_id: ghlConversationId,
      p_event_type: eventType,
      p_metadata: metadata,
    });
  } catch (err) {
    console.error('[logBotEvent] failed to write event:', err instanceof Error ? err.message : String(err));
  }
}

/** Upsert a tenant's GHL OAuth tokens (insert on first install, update on refresh). */
export async function upsertOAuthToken(tenantId: string, tokens: GhlTokenResponse): Promise<void> {
  const supabase = getSupabase();
  const expiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();
  const { error } = await supabase.from('ghl_oauth_tokens').upsert(
    {
      tenant_id: tenantId,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: expiresAt,
      token_type: tokens.token_type,
      scope: tokens.scope,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'tenant_id' },
  );
  fail('upsertOAuthToken', error);
}

/** Fetch the stored OAuth tokens for a tenant, or null if not yet installed. */
export async function getOAuthToken(tenantId: string): Promise<OAuthTokenRow | null> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('ghl_oauth_tokens')
    .select('access_token, refresh_token, expires_at, token_type')
    .eq('tenant_id', tenantId)
    .maybeSingle();
  fail('getOAuthToken', error);
  return (data as OAuthTokenRow | null);
}

/**
 * Returns true when messageId is still the last inbound message logged for
 * this conversation. Used by the debounce gate: if another message arrived
 * during the delay, this returns false and the caller should skip the agent run.
 */
export async function isLatestInboundMessage(
  conversationId: string,
  messageId: string,
): Promise<boolean> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('conversations')
    .select('last_inbound_message_id')
    .eq('id', conversationId)
    .maybeSingle();
  fail('isLatestInboundMessage', error);
  return (data as { last_inbound_message_id: string | null } | null)?.last_inbound_message_id === messageId;
}

/** Cancel all pending follow-ups for a conversation. Call on every inbound message. */
export async function cancelFollowUps(conversationId: string): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase.rpc('app_cancel_follow_ups', {
    p_conversation_id: conversationId,
  });
  fail('cancelFollowUps', error);
}

/**
 * Schedule a follow-up for a conversation. Returns the new follow-up id, or null
 * if the conversation is not active (the RPC no-ops for non-active conversations).
 *
 * The send time is `now + delayMinutes`, clamped out of the tenant's quiet window
 * (DND) so reactivation messages never fire overnight — a time that lands in the
 * window is pushed forward to when it ends (e.g. 08:00 local).
 */
export async function scheduleFollowUp(
  conversationId: string,
  tier: number,
  delayMinutes: number,
  timezone: string,
  quietHours?: QuietHours | null,
  kind: FollowUpKind = 'cadence',
): Promise<string | null> {
  const base = new Date(Date.now() + delayMinutes * 60_000);
  const scheduledFor = clampToActiveHours(base, timezone, quietHours ?? DEFAULT_QUIET_HOURS);
  const supabase = getSupabase();
  const { data, error } = await supabase.rpc('app_schedule_follow_up', {
    p_conversation_id: conversationId,
    p_tier: tier,
    p_scheduled_for: scheduledFor.toISOString(),
    p_kind: kind,
  });
  fail('scheduleFollowUp', error);
  return (data as string | null) ?? null;
}

/**
 * Last check before a nudge goes out: claim the row for sending, or refuse.
 *
 * Returns false when the lead came back while we were generating — either the
 * inbound already cancelled the row, or it landed so recently that only the
 * last-inbound comparison catches it. Either way the nudge must be dropped: it
 * would answer a message the lead has already moved past, which is exactly the
 * collision seen on 2026-07-31 (inbound 15:29:06 → nudge 15:29:14).
 *
 * The atomicity is the point. Reading the status and then sending would just
 * move the race a few milliseconds later; this claims and checks in one
 * statement, so only one of {cancel, send} can win.
 */
export async function commitFollowUpSend(
  followUpId: string,
  lastInboundMessageId: string | null,
): Promise<boolean> {
  const supabase = getSupabase();
  const { data, error } = await supabase.rpc('app_commit_follow_up_send', {
    p_follow_up_id: followUpId,
    p_last_inbound_id: lastInboundMessageId,
  });
  fail('commitFollowUpSend', error);
  return (data as string | null) != null;
}

/**
 * How many demo reminders this conversation has already been SENT — the demo
 * ladder's cursor, mirroring loadSentAngleIndexes for the angle pool.
 *
 * Counting sent rows (not scheduled ones) is what makes the ladder survive an
 * active lead: every inbound cancels the pending nudge and the next turn re-arms
 * rung N+1, so someone who keeps playing with the demo simply never climbs it.
 * Resetting to rung 1 instead would mean reminder #2 — the one that explains how
 * to close the demo — is never reached.
 */
export async function countSentDemoReminders(conversationId: string): Promise<number> {
  const supabase = getSupabase();
  const { data, error } = await supabase.rpc('app_count_sent_demo_reminders', {
    p_conversation_id: conversationId,
  });
  fail('countSentDemoReminders', error);
  return (data as number | null) ?? 0;
}

/** Load follow-ups that are due and ready to be sent. */
export async function loadDueFollowUps(limit = 20): Promise<DueFollowUp[]> {
  const supabase = getSupabase();
  const { data, error } = await supabase.rpc('app_load_due_follow_ups', { p_limit: limit });
  fail('loadDueFollowUps', error);
  type Row = {
    follow_up_id: string;
    conversation_id: string;
    ghl_conversation_id: string;
    ghl_contact_id: string;
    contact_phone: string | null;
    channel: string;
    tier: number;
    ghl_location_id: string;
    kind: string | null;
    last_inbound_message_id: string | null;
  };
  return ((data ?? []) as Row[]).map((r) => ({
    followUpId: r.follow_up_id,
    conversationId: r.conversation_id,
    ghlConversationId: r.ghl_conversation_id,
    ghlContactId: r.ghl_contact_id,
    contactPhone: r.contact_phone,
    channel: r.channel,
    tier: r.tier,
    ghlLocationId: r.ghl_location_id,
    // Defensive default: a row written before 0042 (or by an older Worker) has no
    // kind, and 'cadence' is the behaviour it was scheduled under.
    kind: r.kind === 'demo' ? 'demo' : 'cadence',
    lastInboundMessageId: r.last_inbound_message_id ?? null,
  }));
}

/**
 * Cheap, non-atomic pre-flight: is this claimed row still ours to send?
 *
 * Not a substitute for `commitFollowUpSend` — it exists purely to bail out
 * BEFORE the LLM call in the common case (the lead's inbound already ran
 * `app_cancel_follow_ups`), so an abort costs a read instead of a generation.
 * The atomic gate right before the send is what actually decides.
 */
export async function getFollowUpStatus(followUpId: string): Promise<string | null> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('follow_ups')
    .select('status')
    .eq('id', followUpId)
    .maybeSingle();
  fail('getFollowUpStatus', error);
  return (data as { status: string } | null)?.status ?? null;
}

/** Mark a follow-up as successfully sent. */
export async function markFollowUpSent(followUpId: string, angleIndex: number | null = null): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase.rpc('app_mark_follow_up_sent', {
    p_follow_up_id: followUpId,
    p_angle_index: angleIndex,
  });
  fail('markFollowUpSent', error);
}

/**
 * Angle-pool cursor for a conversation: the indices of pool angles already SENT.
 * Drives non-repeating angle selection — cancelled/undelivered follow-ups never
 * count, so an angle scheduled but not delivered stays available. Free-formed
 * nudges (angle_index NULL) occupy no pool slot and are excluded.
 */
export async function loadSentAngleIndexes(conversationId: string): Promise<number[]> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('follow_ups')
    .select('angle_index')
    .eq('conversation_id', conversationId)
    .eq('status', 'sent')
    .not('angle_index', 'is', null);
  fail('loadSentAngleIndexes', error);
  return ((data ?? []) as { angle_index: number | null }[])
    .map((r) => r.angle_index)
    .filter((n): n is number => typeof n === 'number');
}

/** Mark a follow-up as permanently failed. */
export async function markFollowUpFailed(followUpId: string): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase.rpc('app_mark_follow_up_failed', { p_follow_up_id: followUpId });
  fail('markFollowUpFailed', error);
}

/**
 * Update conversation status and atomically cancel any pending follow-ups.
 * Called by the front-desk updateConversationStatus tool.
 *
 * Returns false when the RPC refused the change (0044): the conversation is in
 * `awaiting_human` and the caller tried to write `standby`/`completed` — the two
 * reactivable states, i.e. the ones that would let the next inbound re-arm the
 * cadence for a lead who is still owed a human answer. Only removing the GHL tag
 * clears that state. **A false means: do not mirror a status tag onto the contact**,
 * or GHL ends up showing `bot-standby` on a lead still tagged `esperando-agenda`.
 *
 * Ordering note: the RPC returned `void` before 0044 and Supabase surfaces that as
 * `null`, which reads as false here. Apply the migration before deploying this.
 */
export async function updateConversationStatus(
  ghlConversationId: string,
  status: ConversationStatus,
): Promise<boolean> {
  const supabase = getSupabase();
  const { data, error } = await supabase.rpc('app_update_conversation_status', {
    p_ghl_conversation_id: ghlConversationId,
    p_status: status,
  });
  fail('updateConversationStatus', error);
  return data === true;
}

/**
 * Upsert a human agent by their GHL user id.
 * Fast path: ghl_user_id already in DB → update name/email and return id.
 * Slow path: insert new row (called after fetching from GHL Users API).
 * Returns the human_agents UUID.
 */
export async function upsertHumanAgent(params: UpsertHumanAgentParams): Promise<string> {
  const supabase = getSupabase();
  const { data, error } = await supabase.rpc('app_upsert_human_agent', params);
  fail('upsertHumanAgent', error);
  return data as string;
}

/** Look up a human_agents row by ghl_user_id. Returns null if not yet in our DB. */
export async function findHumanAgentByGhlId(ghlUserId: string): Promise<string | null> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('human_agents')
    .select('id')
    .eq('ghl_user_id', ghlUserId)
    .maybeSingle();
  fail('findHumanAgentByGhlId', error);
  return (data as { id: string } | null)?.id ?? null;
}

/**
 * Set or refresh the human-active timer for a conversation.
 * Called on every human agent outbound message — slides the window.
 */
export async function setHumanActive(ghlConversationId: string, minutes = 5): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase.rpc('app_set_human_active', {
    p_ghl_conversation_id: ghlConversationId,
    p_minutes: minutes,
  });
  fail('setHumanActive', error);
}

/**
 * Returns true if the bot should stay silent for this conversation:
 *   - manually handed off (permanent, until released), OR
 *   - human-active timer is still running (auto-expires after 5 min of no human messages).
 */
export async function isBotSuppressed(ghlConversationId: string): Promise<boolean> {
  const supabase = getSupabase();
  const { data, error } = await supabase.rpc('app_is_bot_suppressed', {
    p_ghl_conversation_id: ghlConversationId,
  });
  fail('isBotSuppressed', error);
  return Boolean(data);
}

/**
 * Trigger-keyword entry gate (atomic). Given whether the inbound matched a keyword,
 * returns the activation state for the conversation:
 *   'already'   → already activated earlier (proceed)
 *   'activated' → matched now, flag flipped (proceed, first time)
 *   'gated'     → no match and not yet activated (bot stays out)
 */
export async function botActivation(
  conversationId: string,
  matched: boolean,
): Promise<'already' | 'activated' | 'gated'> {
  const supabase = getSupabase();
  const { data, error } = await supabase.rpc('app_bot_activation', {
    p_conversation_id: conversationId,
    p_matched: matched,
  });
  fail('botActivation', error);
  return (data as 'already' | 'activated' | 'gated' | null) ?? 'gated';
}

/**
 * Returns true only if a HUMAN is actively handling the thread (sliding timer).
 * Unlike isBotSuppressed, this ignores `handed_off` — used for the post-generate
 * anti-double check so the agent's OWN self-handoff (which sets handed_off during
 * generation) doesn't suppress its own farewell message.
 */
/**
 * How many messages the conversation already has (by GHL conversation id).
 * Used to tell a cold-outreach opener (first message) from a mid-conversation
 * human takeover. 0 = brand-new conversation.
 */
export async function conversationMessageCount(ghlConversationId: string): Promise<number> {
  const supabase = getSupabase();
  const { count, error } = await supabase
    .from('messages')
    .select('id, conversations!inner(ghl_conversation_id)', { count: 'exact', head: true })
    .eq('conversations.ghl_conversation_id', ghlConversationId);
  fail('conversationMessageCount', error);
  return count ?? 0;
}

export async function isHumanActive(ghlConversationId: string): Promise<boolean> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('conversations')
    .select('human_active_until')
    .eq('ghl_conversation_id', ghlConversationId)
    .maybeSingle();
  fail('isHumanActive', error);
  const until = (data as { human_active_until: string | null } | null)?.human_active_until;
  return until != null && new Date(until).getTime() > Date.now();
}

/**
 * Check if a GHL message ID belongs to a bot message in our DB.
 * Belt-and-suspenders guard in the outbound handler — primary filter is source==='api'.
 */
export async function isBotMessageById(ghlMessageId: string): Promise<boolean> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('messages')
    .select('sender_type')
    .eq('ghl_message_id', ghlMessageId)
    .maybeSingle();
  fail('isBotMessageById', error);
  return (data as { sender_type?: string } | null)?.sender_type === 'bot';
}

/**
 * Content-based echo guard: true if a bot message with this exact content was sent to
 * this conversation within the last `withinSeconds`. Backstop for our own outbound echo
 * when we couldn't capture its GHL message id (so isBotMessageById can't match it) — e.g.
 * a send GHL accepted but whose id we couldn't parse. Prevents that echo from being
 * mislabeled as a human takeover (which would wrongly pause the bot for 5 min).
 */
export async function isRecentBotEcho(
  ghlConversationId: string,
  content: string,
  withinSeconds = 90,
): Promise<boolean> {
  const supabase = getSupabase();
  const since = new Date(Date.now() - withinSeconds * 1000).toISOString();
  const { data, error } = await supabase
    .from('messages')
    .select('id, conversations!inner(ghl_conversation_id)')
    .eq('sender_type', 'bot')
    .eq('content', content)
    .gte('sent_at', since)
    .eq('conversations.ghl_conversation_id', ghlConversationId)
    .limit(1);
  fail('isRecentBotEcho', error);
  return Array.isArray(data) && data.length > 0;
}

/**
 * Reactivate a conversation to 'active' when the lead messages again.
 * Only fires if the conversation is in standby/completed/opted_out.
 */
export async function reactivateConversation(ghlConversationId: string): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase.rpc('app_reactivate_conversation', {
    p_ghl_conversation_id: ghlConversationId,
  });
  fail('reactivateConversation', error);
}
