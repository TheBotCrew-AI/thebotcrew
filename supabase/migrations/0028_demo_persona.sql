-- ============================================================
-- Migration 0028 — demo persona (per-conversation role switch)
-- The Bot Crew · Agent Platform
--
-- Lets a conversation flip between the tenant's normal front-desk agent and a
-- "demo" persona, toggled by control keywords (anyone can turn it on; the lead or
-- the operator can turn it off). Same front-desk engine (tools/flow) — only the
-- prompt/persona changes via demo_prompt_overrides. See docs/business-logic.md.
-- ============================================================

-- Per-conversation active role. NULL = the tenant's normal front-desk agent; 'demo' = demo persona.
ALTER TABLE public.conversations ADD COLUMN IF NOT EXISTS active_role text;

-- Per-tenant demo config (all NULL/empty = feature off for that tenant).
ALTER TABLE public.tenant_config ADD COLUMN IF NOT EXISTS demo_on_keywords  text[];
ALTER TABLE public.tenant_config ADD COLUMN IF NOT EXISTS demo_off_keywords text[];
-- Same shape as prompt_overrides (identity, offering, qualificationNotes, tone, toolInstructions).
ALTER TABLE public.tenant_config ADD COLUMN IF NOT EXISTS demo_prompt_overrides jsonb;

-- Set a conversation's active_role (NULL clears it → back to front-desk).
CREATE OR REPLACE FUNCTION public.app_set_active_role(
  p_ghl_conversation_id text,
  p_active_role         text
) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE public.conversations
  SET active_role = p_active_role
  WHERE ghl_conversation_id = p_ghl_conversation_id;
END;
$$;

-- Allow the new observability event.
ALTER TABLE public.bot_events DROP CONSTRAINT IF EXISTS bot_events_event_type_check;
ALTER TABLE public.bot_events ADD CONSTRAINT bot_events_event_type_check
  CHECK (event_type = ANY (ARRAY[
    'lead_qualified', 'follow_up_sent', 'no_show_recovered', 'out_of_hours_handled',
    'objection_handled', 'reactivation_sent', 'agent_error', 'db_error', 'delivery_error',
    'run_superseded', 'run_suppressed', 'handoff_tag_on', 'handoff_tag_off',
    'channel_disabled', 'test_mode_skip', 'keyword_required', 'bot_activated',
    'availability_checked', 'booking_failed', 'status_changed', 'turn_scheduled',
    'demo_toggled'
  ]));
