-- Add ghl_message_id for idempotent inbound webhook processing
ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS ghl_message_id text;
CREATE UNIQUE INDEX IF NOT EXISTS messages_ghl_message_id_idx
  ON public.messages(ghl_message_id)
  WHERE ghl_message_id IS NOT NULL;

-- Recreate app_log_message with dedup support.
-- Returns NULL when an inbound message with the same ghl_message_id was already
-- processed — the caller should abort and not run the agent again.
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
) RETURNS uuid
LANGUAGE plpgsql
AS $$
DECLARE
  v_conv_id  uuid;
  v_channel  text;
  v_ts       timestamptz := COALESCE(p_sent_at, NOW());
  v_inserted int;
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

  INSERT INTO messages (
    conversation_id, direction, sender_type, sent_at,
    message_length, content, agent_role, human_agent_id, model, ghl_message_id
  ) VALUES (
    v_conv_id, p_direction, p_sender_type, v_ts,
    CHAR_LENGTH(COALESCE(p_content, '')), p_content,
    p_agent_role, p_human_agent_id, p_model, p_ghl_message_id
  )
  ON CONFLICT (ghl_message_id) WHERE ghl_message_id IS NOT NULL DO NOTHING;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  IF v_inserted = 0 AND p_direction = 'inbound' THEN
    RETURN NULL;
  END IF;

  RETURN v_conv_id;
END;
$$;
