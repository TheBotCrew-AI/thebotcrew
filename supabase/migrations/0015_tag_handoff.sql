-- ============================================================
-- Migration 0015 — tag-based handoff (the `bot-off` kill switch)
-- The Bot Crew · Agent Platform
--
-- A human adds the `bot-off` tag to a GHL contact to take the conversation over
-- permanently; removing it hands control back to the bot. GHL fires a
-- ContactTagUpdate webhook, which the Worker maps to conversation status via the
-- function below. That webhook is CONTACT-scoped (no conversationId), so we
-- resolve by ghl_contact_id and affect that contact's conversation(s).
--
-- No double-write loop: when the bot itself adds `bot-off` (on self-handoff),
-- GHL fires this webhook too, but the conversation is already handed_off, so the
-- `status <> 'handed_off'` guard makes it a no-op.
-- ============================================================

-- Allow the new run-outcome / handoff observability events in bot_events.
ALTER TABLE public.bot_events DROP CONSTRAINT IF EXISTS bot_events_event_type_check;
ALTER TABLE public.bot_events ADD CONSTRAINT bot_events_event_type_check
  CHECK (event_type = ANY (ARRAY[
    'lead_qualified', 'follow_up_sent', 'no_show_recovered', 'out_of_hours_handled',
    'objection_handled', 'reactivation_sent', 'agent_error', 'db_error', 'delivery_error',
    'run_superseded', 'run_suppressed', 'handoff_tag_on', 'handoff_tag_off'
  ]));

CREATE OR REPLACE FUNCTION public.app_set_bot_off_by_contact(
  p_ghl_contact_id text,
  p_off            boolean
) RETURNS int
LANGUAGE plpgsql AS $$
DECLARE
  v_id    uuid;
  v_count int := 0;
BEGIN
  IF p_off THEN
    -- Turn the bot OFF: hand off every non-handed-off conversation for this
    -- contact, and cancel any pending follow-ups for each.
    FOR v_id IN
      UPDATE public.conversations
        SET status            = 'handed_off',
            handoff_triggered = true,
            last_message_at   = now()
        WHERE ghl_contact_id = p_ghl_contact_id
          AND status <> 'handed_off'
        RETURNING id
    LOOP
      PERFORM public.app_cancel_follow_ups(v_id);
      v_count := v_count + 1;
    END LOOP;
  ELSE
    -- Turn the bot back ON: only release conversations that were handed_off
    -- (don't override terminal states like completed / opted_out).
    UPDATE public.conversations
      SET status = 'active'
      WHERE ghl_contact_id = p_ghl_contact_id
        AND status = 'handed_off';
    GET DIAGNOSTICS v_count = ROW_COUNT;
  END IF;

  RETURN v_count;
END;
$$;
