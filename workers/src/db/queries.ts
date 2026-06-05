/**
 * Typed DB access for the agent runtime.
 *
 * Reads: tenant config + conversation history (our store, not GHL).
 * Writes: the existing app_log_* RPCs (app_log_message recreated in 0005;
 *         the rest unchanged).
 */

import { getSupabase } from './client.js';
import type { ConversationMessage, TenantContext } from '../core/types.js';
import type {
  LogAppointmentParams,
  LogEventParams,
  LogMessageParams,
  MessageRow,
  TenantConfigRow,
  TenantRow,
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
      'business_name, timezone, tone, services, hours, calendars, faq, enabled_roles, prompt_overrides, ' +
        'tenants!inner(id, client_id, ghl_location_id, ghl_token_ref, is_active)',
    )
    .eq('tenants.ghl_location_id', ghlLocationId)
    .eq('tenants.is_active', true)
    .maybeSingle();
  fail('loadTenantConfig', error);
  if (!data) return null;

  const row = data as unknown as TenantConfigRow & { tenants: TenantRow };
  const t = row.tenants;
  return {
    tenantId: t.id,
    clientId: t.client_id,
    ghlLocationId: t.ghl_location_id,
    ghlTokenRef: t.ghl_token_ref,
    enabledRoles: row.enabled_roles ?? [],
    config: {
      businessName: row.business_name,
      timezone: row.timezone,
      tone: row.tone,
      services: row.services,
      hours: row.hours,
      calendars: row.calendars,
      faq: row.faq,
      promptOverrides: row.prompt_overrides,
    },
  };
}

/**
 * Load the most recent messages for a conversation (chronological order) from
 * OUR store, to rebuild the agent's history. Empty-content rows are skipped.
 */
export async function loadRecentMessages(
  conversationId: string,
  limit = 20,
): Promise<ConversationMessage[]> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('messages')
    .select('direction, sender_type, content, agent_role, human_agent_id, model, sent_at')
    .eq('conversation_id', conversationId)
    .order('sent_at', { ascending: false })
    .limit(limit);
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

/** Upsert the conversation + insert one message. Returns our conversation uuid. */
export async function logMessage(params: LogMessageParams): Promise<{ conversationId: string }> {
  const supabase = getSupabase();
  const { data, error } = await supabase.rpc('app_log_message', params);
  fail('logMessage', error);
  return { conversationId: data as string };
}

/** Record an appointment action (booked / rescheduled / cancelled). Returns appt uuid. */
export async function logAppointment(params: LogAppointmentParams): Promise<{ appointmentId: string }> {
  const supabase = getSupabase();
  const { data, error } = await supabase.rpc('app_log_appointment', params);
  fail('logAppointment', error);
  return { appointmentId: data as string };
}

/** Record a value event (lead_qualified, out_of_hours_handled, …). Returns event uuid. */
export async function logEvent(params: LogEventParams): Promise<{ eventId: string }> {
  const supabase = getSupabase();
  const { data, error } = await supabase.rpc('app_log_event', params);
  fail('logEvent', error);
  return { eventId: data as string };
}

/** Mark a conversation as handed off to a human (pauses the AI for that thread). */
export async function setHandoff(ghlConversationId: string): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase.rpc('app_set_handoff', {
    p_ghl_conversation_id: ghlConversationId,
  });
  fail('setHandoff', error);
}

/** Is this conversation currently owned by a human? (AI should stay silent.) */
export async function isHandedOff(ghlConversationId: string): Promise<boolean> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('conversations')
    .select('status')
    .eq('ghl_conversation_id', ghlConversationId)
    .maybeSingle();
  fail('isHandedOff', error);
  return (data as { status?: string } | null)?.status === 'handed_off';
}
