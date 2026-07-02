-- ============================================================
-- Migration 0029 — demo clean start
-- The Bot Crew · Agent Platform
--
-- When a conversation flips INTO the demo persona, the demo should start clean —
-- not inherit the pre-demo history (e.g. a completed booking) that would confuse it.
-- Track when demo mode began so the turn can load only messages since activation.
-- ============================================================

ALTER TABLE public.conversations ADD COLUMN IF NOT EXISTS demo_started_at timestamptz;

-- Set active_role and stamp/clear demo_started_at accordingly.
CREATE OR REPLACE FUNCTION public.app_set_active_role(
  p_ghl_conversation_id text,
  p_active_role         text
) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE public.conversations
  SET active_role     = p_active_role,
      demo_started_at = CASE WHEN p_active_role = 'demo' THEN now() ELSE NULL END
  WHERE ghl_conversation_id = p_ghl_conversation_id;
END;
$$;
