-- ============================================================
-- Migration 0046 — inbound attachments (voice notes, images)
-- The Bot Crew · Agent Platform
--
-- Until now an attachment-only message was DROPPED before anything was stored.
-- `parseInboundWebhook` requires `body`, and GHL sends `body: ""` for a WhatsApp
-- voice note or photo — so the webhook returned "unparseable", nothing was
-- persisted, no event fired, no reply went out, and (because the inbound never
-- landed) the follow-up cadence was never cancelled either.
--
-- Observed 2026-08-01 on a real FB-ad lead: she answered a qualifying question
-- with a voice note, the answer vanished, and she was left waiting. Confirmed
-- payload shape, read back from the GHL API for that exact message:
--   { direction: 'inbound', messageType: 'TYPE_WHATSAPP', body: '',
--     attachments: ['https://…/44bbff3b-….ogg'] }
-- i.e. `attachments` is an array of URL strings, and the asset is fetchable
-- WITHOUT auth (verified: 206 + content-type audio/ogg).
--
-- This migration only gives the store somewhere to put them. The runtime then
-- transcribes audio and writes the text back into `content`, so history stays
-- plain text for every later turn.
--
-- NOTE: the function body below is prod's CURRENT definition (read via
-- pg_get_functiondef), not a replay of 0010 — that older body would have
-- regressed two things patched since: the channel CASE (`ELSE p_channel`
-- pass-through + the facebook branch, without which every FB/IG row is written
-- as 'whatsapp') and the `last_inbound_message_id` update that the debounce
-- depends on. Only the attachments column is new here.
--
-- ROLLBACK: additive. `p_attachments` defaults to NULL, so the previous Worker
-- keeps calling the 13-arg form unchanged (Postgres resolves it by default).
-- ============================================================

ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS attachments text[];

-- DROP FIRST — adding a parameter makes CREATE OR REPLACE an OVERLOAD, not a
-- replacement. With both the 13- and 14-arg versions present, PostgREST cannot
-- resolve a 13-named-param call ("function is not unique") and EVERY inbound
-- message fails. Caught on a local dry-run; it would have taken prod down.
-- Dropping is safe for rollback: an older Worker sends 13 named params and
-- PostgREST binds them to this function, with p_attachments taking its default.
DROP FUNCTION IF EXISTS public.app_log_message(
  text, uuid, text, text, text, text, text, text, text, uuid, text, timestamptz, text
);

CREATE OR REPLACE FUNCTION public.app_log_message(
  p_ghl_conversation_id text,
  p_client_id           uuid,
  p_channel             text,
  p_ghl_contact_id      text,
  p_contact_phone       text,
  p_direction           text,
  p_sender_type         text,
  p_content             text,
  p_agent_role          text,
  p_human_agent_id      uuid,
  p_model               text,
  p_sent_at             timestamptz,
  p_ghl_message_id      text DEFAULT NULL,
  p_attachments         text[] DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
AS $function$
DECLARE
  v_conv_id    uuid;
  v_msg_id     uuid;
  v_channel    text;
  v_ts         timestamptz := COALESCE(p_sent_at, NOW());
  v_inserted   int;
  v_del_status text;
BEGIN
  v_channel := CASE
    WHEN LOWER(p_channel) LIKE '%insta%' OR UPPER(p_channel) = 'IG' THEN 'instagram'
    WHEN LOWER(p_channel) = 'fb' OR LOWER(p_channel) LIKE '%facebook%'  THEN 'facebook'
    ELSE p_channel  -- already normalized by the Worker; pass through
  END;

  INSERT INTO conversations (
    client_id, channel, ghl_conversation_id, ghl_contact_id,
    contact_phone, started_at, last_message_at, status
  ) VALUES (
    p_client_id, v_channel, p_ghl_conversation_id, p_ghl_contact_id,
    p_contact_phone, v_ts, v_ts, 'active'
  )
  ON CONFLICT (ghl_conversation_id) DO UPDATE SET
    last_message_at = GREATEST(conversations.last_message_at, EXCLUDED.last_message_at),
    contact_phone   = COALESCE(conversations.contact_phone, EXCLUDED.contact_phone),
    ghl_contact_id  = COALESCE(conversations.ghl_contact_id, EXCLUDED.ghl_contact_id)
  RETURNING id INTO v_conv_id;

  v_del_status := CASE
    WHEN p_direction = 'outbound' AND p_sender_type = 'bot' THEN 'pending'
    ELSE NULL
  END;

  INSERT INTO messages (
    conversation_id, direction, sender_type, sent_at,
    message_length, content, agent_role, human_agent_id, model, ghl_message_id,
    delivery_status, attachments
  ) VALUES (
    v_conv_id, p_direction, p_sender_type, v_ts,
    CHAR_LENGTH(COALESCE(p_content, '')), p_content,
    p_agent_role, p_human_agent_id, p_model, p_ghl_message_id,
    v_del_status, p_attachments
  )
  ON CONFLICT (ghl_message_id) WHERE ghl_message_id IS NOT NULL DO NOTHING
  RETURNING id INTO v_msg_id;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  IF v_inserted = 0 AND p_direction = 'inbound' THEN
    RETURN NULL;
  END IF;

  IF p_direction = 'inbound' AND v_msg_id IS NOT NULL THEN
    UPDATE conversations SET last_inbound_message_id = v_msg_id WHERE id = v_conv_id;
  END IF;

  RETURN jsonb_build_object(
    'conversation_id', v_conv_id::text,
    'message_id',      v_msg_id::text
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.app_log_message(text,uuid,text,text,text,text,text,text,text,uuid,text,timestamptz,text,text[]) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.app_log_message(text,uuid,text,text,text,text,text,text,text,uuid,text,timestamptz,text,text[]) TO service_role;

-- Replace a placeholder with the transcribed text once the runtime resolves a
-- voice note, so every later turn reads plain text instead of "[audio]".
CREATE OR REPLACE FUNCTION public.app_set_message_content(
  p_message_id uuid,
  p_content    text
) RETURNS void
LANGUAGE sql AS $$
  UPDATE public.messages
  SET content = p_content, message_length = CHAR_LENGTH(COALESCE(p_content, ''))
  WHERE id = p_message_id;
$$;

REVOKE ALL ON FUNCTION public.app_set_message_content(uuid, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.app_set_message_content(uuid, text) TO service_role;

-- New observability. The full list is prod's CURRENT one (read via
-- pg_get_constraintdef) plus the two new types — reconstructing it from the
-- migration files would have silently dropped 'followup_aborted' and
-- 'demo_reminder_sent', added by 0043.
ALTER TABLE public.bot_events DROP CONSTRAINT IF EXISTS bot_events_event_type_check;
ALTER TABLE public.bot_events ADD CONSTRAINT bot_events_event_type_check
  CHECK (event_type = ANY (ARRAY[
    'lead_qualified', 'follow_up_sent', 'no_show_recovered', 'out_of_hours_handled',
    'objection_handled', 'reactivation_sent', 'agent_error', 'db_error', 'delivery_error',
    'run_superseded', 'run_suppressed', 'handoff_tag_on', 'handoff_tag_off',
    'channel_disabled', 'test_mode_skip', 'keyword_required', 'bot_activated',
    'availability_checked', 'booking_failed', 'status_changed', 'turn_scheduled',
    'demo_toggled', 'ai_key_fallback', 'awaiting_human', 'variant_assigned',
    'demo_session_started', 'demo_session_ended', 'lead_disqualified',
    'followup_aborted', 'demo_reminder_sent', 'status_change_blocked',
    'attachment_received', 'attachment_failed'
  ]));
