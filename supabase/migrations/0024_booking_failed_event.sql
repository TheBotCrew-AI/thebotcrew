-- ============================================================
-- Migration 0024 — booking_failed observability event
-- The Bot Crew · Agent Platform
--
-- bookAppointment only console.error'd GHL rejections (ephemeral Cloudflare logs),
-- so a failed booking left no persisted reason. Now the tool records a
-- 'booking_failed' event with the GHL status/body + startTime/calendarId/service,
-- making the next failure diagnosable from bot_events. Non-destructive: widens the
-- event_type check constraint.
-- ============================================================

ALTER TABLE public.bot_events DROP CONSTRAINT IF EXISTS bot_events_event_type_check;
ALTER TABLE public.bot_events ADD CONSTRAINT bot_events_event_type_check
  CHECK (event_type = ANY (ARRAY[
    'lead_qualified', 'follow_up_sent', 'no_show_recovered', 'out_of_hours_handled',
    'objection_handled', 'reactivation_sent', 'agent_error', 'db_error', 'delivery_error',
    'run_superseded', 'run_suppressed', 'handoff_tag_on', 'handoff_tag_off',
    'channel_disabled', 'test_mode_skip', 'keyword_required', 'bot_activated',
    'availability_checked', 'booking_failed'
  ]));
