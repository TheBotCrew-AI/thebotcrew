-- Debounce: track the most-recently-logged inbound message per conversation.
-- Webhook handlers sleep briefly, then check this field to see if a newer
-- message arrived. Only the handler whose messageId still matches proceeds
-- to run the agent — the rest skip silently.

ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS last_inbound_message_id uuid;

-- Recreate app_log_message to set last_inbound_message_id on each inbound insert.
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
  p_ghl_message_id      text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
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
    ELSE 'whatsapp'
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
    delivery_status
  ) VALUES (
    v_conv_id, p_direction, p_sender_type, v_ts,
    CHAR_LENGTH(COALESCE(p_content, '')), p_content,
    p_agent_role, p_human_agent_id, p_model, p_ghl_message_id,
    v_del_status
  )
  ON CONFLICT (ghl_message_id) WHERE ghl_message_id IS NOT NULL DO NOTHING
  RETURNING id INTO v_msg_id;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  IF v_inserted = 0 AND p_direction = 'inbound' THEN
    RETURN NULL;
  END IF;

  -- Keep the conversation's last-inbound pointer current so debounce checks
  -- can tell which handler should actually run the agent.
  IF p_direction = 'inbound' AND v_msg_id IS NOT NULL THEN
    UPDATE conversations SET last_inbound_message_id = v_msg_id WHERE id = v_conv_id;
  END IF;

  RETURN jsonb_build_object(
    'conversation_id', v_conv_id::text,
    'message_id',      v_msg_id::text
  );
END;
$$;
