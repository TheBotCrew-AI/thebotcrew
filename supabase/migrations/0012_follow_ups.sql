-- Follow-up system: schedule reactivation messages when a lead goes silent.
-- Tenants opt in by configuring follow_up_tiers in tenant_config.

ALTER TABLE public.tenant_config
  ADD COLUMN IF NOT EXISTS follow_up_tiers jsonb;

-- ── Table ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.follow_ups (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid        NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  tier            int         NOT NULL CHECK (tier >= 1),
  status          text        NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending','sent','cancelled','failed')),
  scheduled_for   timestamptz NOT NULL,
  sent_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT NOW()
);

-- Cron runner scans only pending rows, ordered by due time.
CREATE INDEX IF NOT EXISTS idx_follow_ups_pending
  ON public.follow_ups(scheduled_for)
  WHERE status = 'pending';

-- ── Functions ─────────────────────────────────────────────────────────────────

-- Cancel all pending follow-ups for a conversation.
-- Called on every inbound message so leads are never spammed after they reply.
CREATE OR REPLACE FUNCTION public.app_cancel_follow_ups(
  p_conversation_id uuid
) RETURNS void
LANGUAGE sql AS $$
  UPDATE public.follow_ups
  SET status = 'cancelled'
  WHERE conversation_id = p_conversation_id
    AND status = 'pending';
$$;

-- Schedule a follow-up for a conversation.
-- No-ops (returns NULL) if the conversation is not active — prevents scheduling
-- after the front-desk agent marks a conversation completed/opted_out.
CREATE OR REPLACE FUNCTION public.app_schedule_follow_up(
  p_conversation_id uuid,
  p_tier            int,
  p_delay_minutes   int
) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
  v_status text;
  v_id     uuid;
BEGIN
  SELECT status INTO v_status FROM public.conversations WHERE id = p_conversation_id;
  IF v_status IS DISTINCT FROM 'active' THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.follow_ups (conversation_id, tier, status, scheduled_for)
  VALUES (
    p_conversation_id,
    p_tier,
    'pending',
    NOW() + (p_delay_minutes * INTERVAL '1 minute')
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

-- Load follow-ups that are due and ready to be sent.
-- Only returns rows for conversations that are still active.
CREATE OR REPLACE FUNCTION public.app_load_due_follow_ups(
  p_limit int DEFAULT 20
) RETURNS TABLE (
  follow_up_id        uuid,
  conversation_id     uuid,
  ghl_conversation_id text,
  ghl_contact_id      text,
  contact_phone       text,
  channel             text,
  tier                int,
  ghl_location_id     text
)
LANGUAGE sql AS $$
  SELECT
    f.id                  AS follow_up_id,
    f.conversation_id,
    c.ghl_conversation_id,
    c.ghl_contact_id,
    c.contact_phone,
    c.channel,
    f.tier,
    t.ghl_location_id
  FROM public.follow_ups f
  JOIN public.conversations c ON c.id = f.conversation_id
  JOIN public.tenants t ON t.client_id = c.client_id
  WHERE f.status = 'pending'
    AND f.scheduled_for <= NOW()
    AND c.status = 'active'
  ORDER BY f.scheduled_for
  LIMIT p_limit;
$$;

-- Mark a follow-up as successfully sent.
CREATE OR REPLACE FUNCTION public.app_mark_follow_up_sent(
  p_follow_up_id uuid
) RETURNS void
LANGUAGE sql AS $$
  UPDATE public.follow_ups
  SET status = 'sent', sent_at = NOW()
  WHERE id = p_follow_up_id;
$$;

-- Mark a follow-up as permanently failed.
CREATE OR REPLACE FUNCTION public.app_mark_follow_up_failed(
  p_follow_up_id uuid
) RETURNS void
LANGUAGE sql AS $$
  UPDATE public.follow_ups SET status = 'failed' WHERE id = p_follow_up_id;
$$;

-- Update conversation status and atomically cancel any pending follow-ups.
-- Called by the front-desk updateConversationStatus tool when a terminal state
-- is reached (completed, opted_out, standby).
CREATE OR REPLACE FUNCTION public.app_update_conversation_status(
  p_ghl_conversation_id text,
  p_status              text
) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_conv_id uuid;
BEGIN
  UPDATE public.conversations
  SET status = p_status
  WHERE ghl_conversation_id = p_ghl_conversation_id
  RETURNING id INTO v_conv_id;

  IF v_conv_id IS NOT NULL THEN
    PERFORM public.app_cancel_follow_ups(v_conv_id);
  END IF;
END;
$$;

-- Reactivate a silent conversation back to 'active' when the lead messages again.
-- Only fires on standby/completed/opted_out — active and handed_off are untouched.
CREATE OR REPLACE FUNCTION public.app_reactivate_conversation(
  p_ghl_conversation_id text
) RETURNS void
LANGUAGE sql AS $$
  UPDATE public.conversations
  SET status = 'active'
  WHERE ghl_conversation_id = p_ghl_conversation_id
    AND status IN ('standby', 'completed', 'opted_out');
$$;
