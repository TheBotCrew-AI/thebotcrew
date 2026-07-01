/**
 * Hand-written DB row + RPC param types.
 *
 * Kept in sync by hand with supabase/migrations. If we later adopt
 * `supabase gen types`, these can be replaced by the generated types.
 */

import type { Channel, Direction, SenderType } from '../core/types.js';

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
  /** Channels the bot may reply on. NULL = none (installed but silent). */
  enabled_channels: string[] | null;
  /** Pre-live test allowlist: when non-empty, reply only to these GHL contact ids. */
  test_contact_ids: string[] | null;
  /** Entry-gate keywords: when non-empty, the bot only enters a conversation whose
   *  first message contains one of these. NULL/empty = no gating. */
  trigger_keywords: string[] | null;
}

/** One unanswered inbound turn returned by app_load_unanswered_turns (reconciliation). */
export interface UnansweredTurn {
  conversationId: string;
  messageId: string;
  ghlConversationId: string;
  ghlContactId: string;
  contactPhone: string | null;
  channel: string;
  botActivated: boolean;
  content: string;
  ghlMessageId: string | null;
  ghlLocationId: string;
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
  | 'availability_checked';

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
