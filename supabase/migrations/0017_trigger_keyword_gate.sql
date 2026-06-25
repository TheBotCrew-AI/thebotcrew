-- ============================================================
-- Migration 0017 — per-tenant trigger-keyword entry gate
-- The Bot Crew · Agent Platform
--
-- Some tenants only want the bot to ENTER a conversation when the first message
-- contains a keyword (e.g. an ad CTA: "manda Agente"). It's an entry gate, not a
-- per-message filter: once a conversation is activated, it flows normally.
--
-- tenant_config.trigger_keywords: NULL/empty = no gating (current behavior).
-- conversations.bot_activated: set true once the keyword activated the thread.
-- ============================================================

ALTER TABLE public.tenant_config ADD COLUMN IF NOT EXISTS trigger_keywords text[];

ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS bot_activated boolean NOT NULL DEFAULT false;

-- Treat conversations that already have a bot reply as activated, so enabling
-- keywords later never strands an ongoing flow.
UPDATE public.conversations c
  SET bot_activated = true
  WHERE EXISTS (
    SELECT 1 FROM public.messages m
    WHERE m.conversation_id = c.id AND m.sender_type = 'bot'
  );

-- Atomic keyword gate. Returns:
--   'already'   → conversation was already activated (proceed)
--   'activated' → keyword matched now; flag flipped (proceed, first time)
--   'gated'     → no match and not yet activated (bot stays out)
CREATE OR REPLACE FUNCTION public.app_bot_activation(
  p_conversation_id uuid,
  p_matched         boolean
) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_active boolean;
BEGIN
  SELECT bot_activated INTO v_active FROM public.conversations WHERE id = p_conversation_id;
  IF COALESCE(v_active, false) THEN
    RETURN 'already';
  END IF;
  IF p_matched THEN
    UPDATE public.conversations SET bot_activated = true WHERE id = p_conversation_id;
    RETURN 'activated';
  END IF;
  RETURN 'gated';
END;
$$;

-- Allow the new observability events.
ALTER TABLE public.bot_events DROP CONSTRAINT IF EXISTS bot_events_event_type_check;
ALTER TABLE public.bot_events ADD CONSTRAINT bot_events_event_type_check
  CHECK (event_type = ANY (ARRAY[
    'lead_qualified', 'follow_up_sent', 'no_show_recovered', 'out_of_hours_handled',
    'objection_handled', 'reactivation_sent', 'agent_error', 'db_error', 'delivery_error',
    'run_superseded', 'run_suppressed', 'handoff_tag_on', 'handoff_tag_off',
    'channel_disabled', 'test_mode_skip', 'keyword_required', 'bot_activated'
  ]));
