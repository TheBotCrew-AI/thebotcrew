-- ============================================================
-- Migration 0067 — the lead's stage (NI / I / A / C), shadow mode
-- The Bot Crew · Agent Platform
--
-- How far a conversation got before the lead went quiet, read from the thread:
--   NI  no information — only the ad's pre-filled opener, never answered the bot
--   I   information    — the bot gave the offer/price, the lead stopped there
--   A   advisory       — the lead asked their own questions (interest known)
--   C   commitment     — the lead saw slots or said they want it
-- The follow-up playbook (a later release) picks a ladder per stage. This release
-- only COMPUTES and RECORDS it: nothing the lead receives changes.
--
-- Precedence lives in the RPC, not the Worker, because the floor is re-derived on
-- every turn from signals and a later turn can carry fewer of them (the history
-- window is 20 messages): a stage ONLY RISES. 'rules' is the deterministic floor;
-- 'llm' is the classifier's raise ("dijo que sí" has no event to key on).
--
-- `interest` (0058) was computed per turn and written only to a GHL tag; the
-- playbook needs it on the row, so it is persisted here too (last non-null wins).
--
-- Expand-only: nullable columns, a new RPC, one new event type. The deployed
-- Worker neither reads nor writes any of it.
-- ============================================================

ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS stage        text,
  ADD COLUMN IF NOT EXISTS stage_source text,
  ADD COLUMN IF NOT EXISTS stage_at     timestamptz,
  ADD COLUMN IF NOT EXISTS interest     text;

ALTER TABLE public.conversations DROP CONSTRAINT IF EXISTS conversations_stage_check;
ALTER TABLE public.conversations ADD CONSTRAINT conversations_stage_check
  CHECK (stage IS NULL OR stage IN ('NI', 'I', 'A', 'C'));

ALTER TABLE public.conversations DROP CONSTRAINT IF EXISTS conversations_stage_source_check;
ALTER TABLE public.conversations ADD CONSTRAINT conversations_stage_source_check
  CHECK (stage_source IS NULL OR stage_source IN ('rules', 'llm'));

COMMENT ON COLUMN public.conversations.stage IS
  'How far the lead got (NI/I/A/C, 0067). Only rises — see app_set_conversation_stage.';
COMMENT ON COLUMN public.conversations.interest IS
  'The configured service the lead asked about (0058 classifier), last non-null pick.';

-- Returns {"written": bool, "from": previous stage or null}. Writes only when the
-- new stage is strictly higher than the stored one (NULL < NI < I < A < C).
CREATE OR REPLACE FUNCTION public.app_set_conversation_stage(
  p_ghl_conversation_id text,
  p_stage               text,
  p_source              text
) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  v_prev text;
  v_rank_new int;
  v_rank_prev int;
BEGIN
  IF p_stage IS NULL OR p_stage NOT IN ('NI', 'I', 'A', 'C') OR p_source NOT IN ('rules', 'llm') THEN
    RETURN jsonb_build_object('written', false, 'from', NULL);
  END IF;

  SELECT stage INTO v_prev FROM public.conversations
  WHERE ghl_conversation_id = p_ghl_conversation_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('written', false, 'from', NULL);
  END IF;

  v_rank_new  := array_position(ARRAY['NI', 'I', 'A', 'C'], p_stage);
  v_rank_prev := COALESCE(array_position(ARRAY['NI', 'I', 'A', 'C'], v_prev), 0);
  IF v_rank_new <= v_rank_prev THEN
    RETURN jsonb_build_object('written', false, 'from', v_prev);
  END IF;

  UPDATE public.conversations
  SET stage = p_stage, stage_source = p_source, stage_at = NOW()
  WHERE ghl_conversation_id = p_ghl_conversation_id;
  RETURN jsonb_build_object('written', true, 'from', v_prev);
END;
$$;

CREATE OR REPLACE FUNCTION public.app_set_conversation_interest(
  p_ghl_conversation_id text,
  p_interest            text
) RETURNS void
LANGUAGE sql AS $$
  UPDATE public.conversations SET interest = p_interest
  WHERE ghl_conversation_id = p_ghl_conversation_id AND p_interest IS NOT NULL;
$$;

-- Per 0032: revoke the default PUBLIC grant explicitly, grant service_role.
REVOKE ALL ON FUNCTION public.app_set_conversation_stage(text, text, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.app_set_conversation_stage(text, text, text) TO service_role;
REVOKE ALL ON FUNCTION public.app_set_conversation_interest(text, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.app_set_conversation_interest(text, text) TO service_role;

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
    'attachment_received', 'attachment_failed',
    'capi_event_sent', 'capi_error',
    'reactivation_exhausted', 'pending_info',
    'resume_skipped',
    'pending_info_escalated', 'info_gap_error',
    'interest_tagged',
    'turn_answered',
    'hold_created', 'hold_released', 'hold_expired',
    'booking_paid', 'booking_paid_late', 'payment_error',
    'hold_reminder_sent',
    'prime_time_released',
    -- 0067
    'stage_changed'
  ]));

-- Where each tenant's leads stand, by stage and status: the read that calibrates the
-- playbook ladders (a `standby` row is a lead the ladder lost at that stage).
CREATE OR REPLACE VIEW public.stage_at_silence
WITH (security_invoker = on) AS
SELECT c.client_id,
       c.channel,
       COALESCE(c.stage, 'none') AS stage,
       c.status,
       count(*) AS conversations
FROM public.conversations c
WHERE c.stage_at IS NOT NULL
GROUP BY c.client_id, c.channel, COALESCE(c.stage, 'none'), c.status;

REVOKE ALL ON public.stage_at_silence FROM anon, authenticated;
