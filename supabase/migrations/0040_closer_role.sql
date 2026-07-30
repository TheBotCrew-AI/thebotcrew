-- ============================================================
-- Migration 0040 — the closer is a PERSONA, not a single turn
-- The Bot Crew · Agent Platform
--
-- Bug (live 2026-07-30): when a demo session ended, app_end_demo_session set
-- active_role = NULL, so the post-demo "closer" instructions only existed on
-- the ONE turn where the flip happened. Consequences, both observed:
--   · that turn's history is a single lead message (the flip anchors at the
--     latest inbound), so with the tenant's normal sales flow also in the
--     prompt the model read it as a cold open and answered "¿con quién tengo
--     el gusto?" — to a lead whose name it had just been given;
--   · every turn AFTER it had no closer instructions at all, so the setter
--     script (soft pitch → qualify → book, or discovery on a no) evaporated.
--
-- Fix: ending a session parks the conversation in active_role = 'closer'.
-- It's a normal (non-demo) persona — every activeRole==='demo' guard stays
-- false, so follow-ups, the classifier and the real tools all behave normally
-- — but the runtime rebuilds the handoff context from the latest ended
-- session on every turn, so the setter flow persists for the whole
-- post-demo conversation.
--
-- 'closer' is cleared the usual ways: a new demo (app_create_demo_session sets
-- 'demo') or a demo-off keyword on a conversation with no session.
--
-- ROLLBACK: re-run the 0038 body of app_end_demo_session (CREATE OR REPLACE).
-- No schema change; active_role has no CHECK constraint, and older code reads
-- an unknown role as "not demo" — i.e. exactly today's NULL behavior.
-- ============================================================

CREATE OR REPLACE FUNCTION public.app_end_demo_session(
  p_session_id uuid,
  p_reason     text
) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_ghl_conv text;
BEGIN
  UPDATE public.demo_sessions
  SET status = 'ended', end_reason = p_reason, ended_at = now()
  WHERE id = p_session_id AND status = 'active'
  RETURNING ghl_conversation_id INTO v_ghl_conv;

  IF v_ghl_conv IS NOT NULL THEN
    -- Park in the closer persona (was NULL): re-stamps role_started_at at the
    -- latest inbound, so the closer starts clean on the lead's last message.
    PERFORM public.app_set_active_role(v_ghl_conv, 'closer');
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.app_end_demo_session(uuid, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.app_end_demo_session(uuid, text) TO service_role;
