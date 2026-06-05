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

/** Params for the app_log_message RPC (matches migration 0005). */
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
}

export type AppointmentAction = 'booked' | 'rescheduled' | 'cancelled';

export type BotEventType =
  | 'lead_qualified'
  | 'follow_up_sent'
  | 'no_show_recovered'
  | 'out_of_hours_handled'
  | 'objection_handled'
  | 'reactivation_sent';

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
