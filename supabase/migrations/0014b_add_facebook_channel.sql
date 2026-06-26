-- ============================================================
-- Migration 0014b — Facebook channel support
-- The Bot Crew · Agent Platform
--
-- Backfilled from remote (version 20260613221900). Captures a change that
-- had been applied directly to production but was missing from the repo.
--
-- Contract note: app_log_message normalizes 'fb'/'facebook' → 'facebook' and
-- 'insta'/'IG' → 'instagram', but otherwise PASSES THROUGH the channel
-- assuming the caller already sent it lowercase (the Worker normalizes before
-- calling). Callers (Worker, n8n, any integration) MUST send the channel as
-- 'whatsapp' | 'instagram' | 'facebook' — an unnormalized value like
-- 'WhatsApp' falls into the ELSE and violates conversations_channel_check.
-- ============================================================

-- Add 'facebook' to the channel constraint on conversations.
ALTER TABLE public.conversations
  DROP CONSTRAINT IF EXISTS conversations_channel_check;

ALTER TABLE public.conversations
  ADD CONSTRAINT conversations_channel_check
  CHECK (channel IN ('whatsapp', 'instagram', 'facebook'));

-- Update app_log_message normalization to handle FB.
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
LANGUAGE plpgsql AS $$
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

  IF p_direction = 'inbound' AND v_msg_id IS NOT NULL THEN
    UPDATE conversations SET last_inbound_message_id = v_msg_id WHERE id = v_conv_id;
  END IF;

  RETURN jsonb_build_object(
    'conversation_id', v_conv_id::text,
    'message_id',      v_msg_id::text
  );
END;
$$;
