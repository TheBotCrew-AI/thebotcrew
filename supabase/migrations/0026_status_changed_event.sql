-- ============================================================
-- Migration 0026 — status_changed observability event
-- The Bot Crew · Agent Platform
--
-- updateConversationStatus (agent tool + follow-up runner) could silently move a
-- conversation to standby/completed/opted_out/handed_off with no trace — so a
-- "silent standby" (agent ends a fresh lead without replying) was only inferrable
-- from the status field. Now app_update_conversation_status logs a 'status_changed'
-- event ({from, to}) at the single SQL choke point, capturing every path.
-- ============================================================

ALTER TABLE public.bot_events DROP CONSTRAINT IF EXISTS bot_events_event_type_check;
ALTER TABLE public.bot_events ADD CONSTRAINT bot_events_event_type_check
  CHECK (event_type = ANY (ARRAY[
    'lead_qualified', 'follow_up_sent', 'no_show_recovered', 'out_of_hours_handled',
    'objection_handled', 'reactivation_sent', 'agent_error', 'db_error', 'delivery_error',
    'run_superseded', 'run_suppressed', 'handoff_tag_on', 'handoff_tag_off',
    'channel_disabled', 'test_mode_skip', 'keyword_required', 'bot_activated',
    'availability_checked', 'booking_failed', 'status_changed'
  ]));

CREATE OR REPLACE FUNCTION public.app_update_conversation_status(
  p_ghl_conversation_id text,
  p_status              text
) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_conv_id   uuid;
  v_client_id uuid;
  v_old       text;
BEGIN
  SELECT id, client_id, status INTO v_conv_id, v_client_id, v_old
  FROM public.conversations
  WHERE ghl_conversation_id = p_ghl_conversation_id;

  IF v_conv_id IS NULL THEN
    RETURN;
  END IF;

  UPDATE public.conversations SET status = p_status WHERE id = v_conv_id;
  PERFORM public.app_cancel_follow_ups(v_conv_id);

  INSERT INTO public.bot_events (client_id, conversation_id, event_type, metadata)
  VALUES (v_client_id, v_conv_id, 'status_changed',
          jsonb_build_object('from', v_old, 'to', p_status));
END;
$$;
