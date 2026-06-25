-- ============================================================
-- Migration 0013 — human agent takeover (sliding timer)
-- The Bot Crew · Agent Platform
--
-- When a human agent replies in GHL, the bot pauses for 5 minutes.
-- Each human message refreshes the timer. On the next inbound lead
-- message after the timer expires, the bot resumes automatically.
--
-- Also adds ghl_user_id to human_agents so we can link GHL users
-- to our roster without a separate lookup every time.
-- ============================================================

-- ── human_agents: GHL user identifier ────────────────────────────────────────

ALTER TABLE public.human_agents
  ADD COLUMN IF NOT EXISTS ghl_user_id text UNIQUE;

-- ── conversations: sliding human-active timer ─────────────────────────────────

ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS human_active_until timestamptz;

-- Only index rows where the timer is set — keeps the scan cheap.
CREATE INDEX IF NOT EXISTS idx_conversations_human_active
  ON public.conversations(human_active_until)
  WHERE human_active_until IS NOT NULL;

-- ── Functions ─────────────────────────────────────────────────────────────────

-- Upsert a human agent by their GHL user ID.
-- Called lazily when we see a new userId in an outbound webhook.
CREATE OR REPLACE FUNCTION public.app_upsert_human_agent(
  p_client_id   uuid,
  p_ghl_user_id text,
  p_name        text,
  p_email       text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO public.human_agents (client_id, ghl_user_id, name, email, is_active)
  VALUES (p_client_id, p_ghl_user_id, p_name, p_email, true)
  ON CONFLICT (ghl_user_id) DO UPDATE
    SET name      = EXCLUDED.name,
        email     = COALESCE(EXCLUDED.email, human_agents.email),
        is_active = true
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

-- Set or refresh the human-active timer for a conversation.
-- Calling this multiple times (one per human message) slides the window.
CREATE OR REPLACE FUNCTION public.app_set_human_active(
  p_ghl_conversation_id text,
  p_minutes             int DEFAULT 5
) RETURNS void
LANGUAGE sql AS $$
  UPDATE public.conversations
  SET human_active_until = NOW() + (p_minutes * INTERVAL '1 minute')
  WHERE ghl_conversation_id = p_ghl_conversation_id;
$$;

-- Composite bot-suppression check:
--   true  → handed_off (manual, permanent) OR human timer still running
--   false → bot is free to respond
CREATE OR REPLACE FUNCTION public.app_is_bot_suppressed(
  p_ghl_conversation_id text
) RETURNS boolean
LANGUAGE sql AS $$
  SELECT COALESCE(
    (
      SELECT status = 'handed_off'
          OR (human_active_until IS NOT NULL AND human_active_until > NOW())
      FROM public.conversations
      WHERE ghl_conversation_id = p_ghl_conversation_id
    ),
    false
  );
$$;
