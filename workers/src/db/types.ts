/**
 * Hand-written DB row + RPC param types.
 *
 * Kept in sync by hand with supabase/migrations. If we later adopt
 * `supabase gen types`, these can be replaced by the generated types.
 */

import type { Channel, Direction, FollowUpKind, SenderType } from '../core/types.js';

/** Row shape from `tenant_config` (jsonb columns arrive parsed). */
export interface TenantConfigRow {
  business_name: string;
  timezone: string;
  tone: string | null;
  services: unknown;
  hours: unknown;
  calendars: unknown;
  faq: unknown;
  enabled_roles: string[];
  prompt_overrides: unknown;
  ai_provider: string | null;
  ai_model: string | null;
  follow_up_tiers: unknown;
  /** Delays (minutes) per attempt in a follow-up cycle. */
  follow_up_cadence: unknown;
  /** Pool of angle directives for reactivation, decoupled from cadence. */
  follow_up_angles: unknown;
  /** Cadences for reactivation rounds 1+ as an array of arrays of minutes (0049).
   *  NULL = platform default taper; [] = round 0 only. */
  follow_up_rounds: unknown;
  /** Quiet (DND) window for follow-ups as {start,end} local hours. NULL = platform default. */
  quiet_hours: unknown;
  /** Max days ahead the bot may offer appointment slots. NULL = no cap. */
  booking_horizon_days: number | null;
  /** Channels the bot may reply on. NULL = none (installed but silent). */
  enabled_channels: string[] | null;
  /** Pre-live test allowlist: when non-empty, reply only to these GHL contact ids. */
  test_contact_ids: string[] | null;
  /** Entry-gate keywords: when non-empty, the bot only enters a conversation whose
   *  first message contains one of these. NULL/empty = no gating. */
  trigger_keywords: string[] | null;
  /** Keywords that switch a conversation into / out of the demo persona. */
  demo_on_keywords: string[] | null;
  demo_off_keywords: string[] | null;
  /** Campaign keyword → prompt-variant key (n:1). NULL = no variants. */
  keyword_variants: unknown;
  /** Variant key → partial prompt overrides, merged over prompt_overrides. */
  prompt_variants: unknown;
  /** Prompt overrides for the demo persona (same shape as prompt_overrides). */
  demo_prompt_overrides: unknown;
  /** Slug of the Worker secret with this tenant's AI key. NULL = platform key. */
  ai_key_ref: string | null;
  /** Tag applied when the bot leaves a request awaiting a human. NULL = unused. */
  awaiting_human_tag: string | null;
  /** Whether startDemo may create budgeted per-lead demo sessions (lead-magnet funnel). */
  demo_sessions_enabled: boolean | null;
  /** Meta Conversions API config ({dataset_id, page_id, token_ref, …}). NULL = off. */
  meta_capi: unknown;
}

/** One row returned by app_load_due_follow_ups. */
export interface DueFollowUp {
  followUpId: string;
  conversationId: string;
  ghlConversationId: string;
  ghlContactId: string;
  contactPhone: string | null;
  channel: string;
  tier: number;
  ghlLocationId: string;
  /** Which ladder this row belongs to (0042). Rows written before 0042 read 'cadence'. */
  kind: FollowUpKind;
  /** The reactivation round this row was scheduled under (0049) — resolves the
   *  cadence shape for rung progression. Rows written before 0049 read 0. */
  round: number;
  /**
   * The conversation's last inbound as of the CLAIM. The runner hands it back to
   * `app_commit_follow_up_send` right before sending: if it no longer matches, the
   * lead replied while the LLM was generating and the nudge must not go out.
   */
  lastInboundMessageId: string | null;
}

/** Embedded `tenants` row when querying from `tenant_config`. */
export interface TenantRow {
  id: string;
  client_id: string;
  ghl_location_id: string;
  is_active: boolean;
}

/** Row from `ghl_oauth_tokens`. */
export interface OAuthTokenRow {
  access_token: string;
  refresh_token: string;
  expires_at: string;
  token_type: string;
}

/** Row shape returned by loadRecentMessages. */
export interface MessageRow {
  direction: Direction;
  sender_type: SenderType;
  content: string | null;
  agent_role: string | null;
  human_agent_id: string | null;
  model: string | null;
  sent_at: string;
}

/** Return type of the app_log_message RPC (migration 0010: now returns jsonb). */
export interface LogMessageResult {
  conversationId: string | null;
  messageId: string | null;
}

/** Params for the app_enqueue_capi_event RPC (0048). */
export interface EnqueueCapiEventParams {
  p_client_id: string;
  p_ghl_conversation_id: string;
  p_kind: string;
  p_event_name: string;
  /** `${ghl_conversation_id}:${kind}` — the queue's UNIQUE key and Meta's dedup id. */
  p_event_id: string;
  /** Frozen {user_data, custom_data?} snapshot built at enqueue. */
  p_payload: Record<string, unknown>;
}

/** One row returned by app_load_pending_capi_events (0048). */
export interface PendingCapiEvent {
  id: string;
  clientId: string;
  ghlConversationId: string;
  kind: string;
  eventName: string;
  eventId: string;
  /** ISO timestamp the event happened (sent to Meta as event_time). */
  eventTime: string;
  payload: { user_data: Record<string, unknown>; custom_data?: Record<string, unknown> };
  attempts: number;
  lastError: string | null;
  createdAt: string;
  tenantId: string;
  /** The tenant's LIVE meta_capi jsonb, joined fresh each drain. */
  metaCapi: unknown;
}

/** A pending outbound bot message returned by app_load_pending_deliveries. */
export interface PendingDelivery {
  messageId: string;
  content: string;
  channel: string;
  ghlConversationId: string;
  ghlContactId: string;
  contactPhone: string | null;
  tenantId: string;
  retryCount: number;
}

/** Params for the app_log_message RPC (matches migration 0008). */
export interface LogMessageParams {
  p_ghl_conversation_id: string;
  p_client_id: string;
  p_channel: Channel | string;
  p_ghl_contact_id: string;
  p_contact_phone: string | null;
  p_direction: Direction;
  p_sender_type: SenderType;
  p_content: string;
  p_agent_role: string | null;
  p_human_agent_id: string | null;
  p_model: string | null;
  p_sent_at: string | null;
  /** GHL message id for deduplication. Null for outbound. */
  p_ghl_message_id?: string | null;
  /** Media URLs the lead attached (0046). Null/omitted for text-only messages. */
  p_attachments?: string[] | null;
}

/** Params for the app_upsert_human_agent RPC (migration 0013). */
export interface UpsertHumanAgentParams {
  p_client_id: string;
  p_ghl_user_id: string;
  p_name: string;
  p_email?: string | null;
}

export type AppointmentAction = 'booked' | 'rescheduled' | 'cancelled';

export type BotEventType =
  | 'lead_qualified'
  | 'follow_up_sent'
  | 'no_show_recovered'
  | 'out_of_hours_handled'
  | 'objection_handled'
  | 'reactivation_sent'
  // Error/observability events
  | 'agent_error'      // agent.generate() threw
  | 'delivery_error'   // GHL sendMessage failed
  | 'db_error'         // DB write failed
  // Run-outcome / handoff observability — why a turn did (not) produce a reply
  | 'run_superseded'   // debounced run skipped: a newer inbound message arrived
  | 'run_suppressed'   // run skipped: human active or handed_off (see metadata.stage)
  | 'handoff_tag_on'   // `bot-off` tag added → conversation(s) handed off
  | 'handoff_tag_off'  // `bot-off` tag removed → conversation(s) reactivated
  // Per-tenant gating
  | 'channel_disabled' // inbound channel not in the tenant's enabled_channels
  | 'test_mode_skip'   // test allowlist active and this contact isn't on it
  | 'keyword_required' // trigger keyword gate: message lacked the keyword
  | 'bot_activated'    // trigger keyword matched → conversation entered the flow
  // Availability observability — raw slots GHL returned for a given check
  | 'availability_checked'
  // Booking observability — GHL rejected a bookAppointment call (status/body in metadata)
  | 'booking_failed'
  // Conversation state changed via app_update_conversation_status ({from,to} in metadata)
  | 'status_changed'
  // Turn handed to the per-conversation Durable Object (Phase 1 durable-turn path)
  | 'turn_scheduled'
  // Tenant has ai_key_ref but its Worker secret is missing → platform key used
  | 'ai_key_fallback'
  // Campaign prompt variant pinned to a conversation (first touch; {variant, keyword, known})
  | 'variant_assigned'
  // Demo session lifecycle (lead-magnet funnel): created via startDemo / ended (budget|expiry)
  | 'demo_session_started'
  | 'demo_session_ended'
  // Bot left a request ready for a person to pick up (flagAwaitingHuman)
  | 'awaiting_human'
  // Conversation switched into / out of the demo persona ({to} in metadata)
  | 'demo_toggled'
  // The bot ruled a lead out and parked it ({status, reason} in metadata, 0042).
  // Reason is the model's own words — read it, don't just count rows: an
  // unexpected reason is the fingerprint of a model disqualifying on its own terms.
  | 'lead_disqualified'
  // A claimed follow-up was dropped instead of sent ({reason, kind, tier}, 0043).
  // The only record that a nudge was correctly withheld — its absence is what
  // made the send race invisible for so long.
  | 'followup_aborted'
  // An out-of-character "your demo is still open" nudge went out ({rung}, 0043)
  | 'demo_reminder_sent'
  // A status write was refused ({from,to,why}, 0044). Today the only `why` is
  // `awaiting_human_is_sticky`: the model tried to park a lead who is already
  // waiting on a person, which would have made her reactivable on her next message.
  // Written by the RPC, never by the Worker — it's the record of a bug not happening.
  | 'status_change_blocked'
  // An inbound carried media (0046): received = stored (and, for audio, transcribed);
  // failed = we could not resolve it and fell back to the placeholder.
  | 'attachment_received'
  | 'attachment_failed'
  // Meta CAPI (0048): a conversion signal reached Meta ({kind, eventName, eventId})
  // / a queued event could not be sent ({stage|error}; missing_token_secret is the
  // one that self-heals — the row stays pending until the Worker secret lands).
  | 'capi_event_sent'
  | 'capi_error'
  // The FINAL reactivation round exhausted unanswered ({round, followUpId}, 0049):
  // the lead got the farewell and the arming gate now keeps every nudge off. The
  // runner also writes the `reactivacion-agotada` GHL tag alongside this.
  | 'reactivation_exhausted';

export interface LogAppointmentParams {
  p_client_id: string;
  p_ghl_contact_id: string;
  p_action: AppointmentAction;
  p_appointment_datetime: string | null;
  p_service_type: string | null;
  p_source: string | null;
  p_ghl_appointment_id: string | null;
}

export interface LogEventParams {
  p_client_id: string;
  p_ghl_conversation_id: string;
  p_event_type: BotEventType;
  p_metadata: Record<string, unknown>;
}
