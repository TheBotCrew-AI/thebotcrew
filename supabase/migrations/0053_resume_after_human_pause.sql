-- ============================================================
-- Migration 0053 — resume after the human pause: the audit event
-- The Bot Crew · Agent Platform
--
-- A lead message that arrives while a human has the thread paused used to be
-- dropped for good: the turn ran at the debounce alarm, saw the pause, logged
-- `run_suppressed` and that was the end of it. Nothing re-checked the thread when
-- the pause expired, so if the human never answered, neither did anyone (MADI,
-- 2026-08-05: 19 hours of silence on an active lead). The reconciliation cron
-- deleted in 0030 used to catch exactly this by accident; the 30-minute pause
-- (0052) made the gap six times wider.
--
-- The Worker now re-arms the conversation's Durable Object alarm for the pause
-- expiry and re-runs the turn flagged `resumed`. Before answering it checks that
-- nobody replied meanwhile and that the lead's last message still asks for
-- something (a cheap classifier: "Gracias" gets no reply). Each silence is an
-- explicit `resume_skipped` event with its reason, so an unanswered lead is never
-- again indistinguishable from a deliberate skip.
-- ============================================================

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
    'resume_skipped'
  ]));
