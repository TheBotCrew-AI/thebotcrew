-- ============================================================
-- Migration 0037 — demo re-stamp bug fix (idempotent activation)
-- The Bot Crew · Agent Platform
--
-- Bug (live since 0029): the demo-on keyword check runs on EVERY inbound, and
-- app_set_active_role stamped demo_started_at = now() on every 'demo' set. So a
-- mid-demo message containing the on-keyword re-stamped the clock → the
-- clean-start history filter truncated to zero → the persona forgot the whole
-- conversation ("demo amnesia"). With a public campaign keyword that leads
-- naturally repeat, this fires constantly.
--
-- Fix: stamp demo_started_at only on an actual TRANSITION into demo
-- (IS DISTINCT FROM); re-setting 'demo' keeps the original timestamp.
-- Leaving demo still clears it (unchanged).
--
-- ROLLBACK: re-run the 0029 definition of app_set_active_role (CREATE OR
-- REPLACE is idempotent both ways). No schema change.
-- ============================================================

CREATE OR REPLACE FUNCTION public.app_set_active_role(
  p_ghl_conversation_id text,
  p_active_role         text
) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE public.conversations
  SET demo_started_at = CASE
        WHEN p_active_role = 'demo' AND active_role IS DISTINCT FROM 'demo' THEN now()
        WHEN p_active_role = 'demo' THEN demo_started_at
        ELSE NULL
      END,
      active_role     = p_active_role
  WHERE ghl_conversation_id = p_ghl_conversation_id;
END;
$$;

-- 0028/0029 predate the 0032 grant rules — re-assert them on the replaced function.
REVOKE ALL ON FUNCTION public.app_set_active_role(text, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.app_set_active_role(text, text) TO service_role;
