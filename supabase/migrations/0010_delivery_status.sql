-- Delivery tracking for outbound bot messages.
-- Enables inline + cron-based retry without re-calling the LLM.

ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS delivery_status text,
  ADD COLUMN IF NOT EXISTS retry_count     int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS delivered_at    timestamptz;

-- Fast scan for the cron retry job
CREATE INDEX IF NOT EXISTS idx_messages_pending_delivery
  ON public.messages(sent_at)
  WHERE delivery_status = 'pending';

-- Drop and recreate app_log_message with new return type (uuid → jsonb).
DROP FUNCTION IF EXISTS public.app_log_message(text,uuid,text,text,text,text,text,text,text,uuid,text,timestamptz,text);

CREATE FUNCTION public.app_log_message(
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

  RETURN jsonb_build_object(
    'conversation_id', v_conv_id::text,
    'message_id',      v_msg_id::text
  );
END;
$$;

-- Mark a message as successfully delivered.
CREATE OR REPLACE FUNCTION public.app_mark_delivered(
  p_message_id uuid
) RETURNS void
LANGUAGE sql
AS $$
  UPDATE public.messages
  SET delivery_status = 'delivered',
      delivered_at    = NOW()
  WHERE id = p_message_id;
$$;

-- Mark a message as permanently failed (retries exhausted).
CREATE OR REPLACE FUNCTION public.app_mark_delivery_failed(
  p_message_id uuid
) RETURNS void
LANGUAGE sql
AS $$
  UPDATE public.messages
  SET delivery_status = 'failed'
  WHERE id = p_message_id;
$$;

-- Increment the retry counter before each cron retry attempt.
CREATE OR REPLACE FUNCTION public.app_increment_retry_count(
  p_message_id uuid
) RETURNS void
LANGUAGE sql
AS $$
  UPDATE public.messages SET retry_count = retry_count + 1 WHERE id = p_message_id;
$$;

-- Load outbound bot messages that need cron retry.
-- Only returns messages older than 30s (avoids racing with the inline webhook retry)
-- and with fewer than 3 cron retry attempts.
CREATE OR REPLACE FUNCTION public.app_load_pending_deliveries(
  p_limit int DEFAULT 20
) RETURNS TABLE (
  message_id          uuid,
  content             text,
  channel             text,
  ghl_conversation_id text,
  ghl_contact_id      text,
  contact_phone       text,
  tenant_id           uuid,
  retry_count         int
)
LANGUAGE sql
AS $$
  SELECT
    m.id            AS message_id,
    m.content,
    c.channel,
    c.ghl_conversation_id,
    c.ghl_contact_id,
    c.contact_phone,
    t.id            AS tenant_id,
    m.retry_count
  FROM public.messages m
  JOIN public.conversations c ON c.id = m.conversation_id
  JOIN public.tenants t ON t.client_id = c.client_id
  WHERE m.delivery_status = 'pending'
    AND m.sent_at < NOW() - INTERVAL '30 seconds'
    AND m.retry_count < 3
  ORDER BY m.sent_at
  LIMIT p_limit;
$$;
