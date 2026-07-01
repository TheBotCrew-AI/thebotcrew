-- ============================================================
-- Migration 0021 — availability_checked observability event
-- The Bot Crew · Agent Platform
--
-- The getAvailability tool now records the RAW slots GHL returned on every check
-- (event_type = 'availability_checked', slots in metadata). This lets us audit an
-- availability claim against ground truth instead of inferring it from what the
-- agent happened to say — the trace we lacked when a reply contradicted its own
-- slot list. Non-destructive: widens the bot_events event_type check constraint.
-- ============================================================

ALTER TABLE public.bot_events DROP CONSTRAINT IF EXISTS bot_events_event_type_check;
ALTER TABLE public.bot_events ADD CONSTRAINT bot_events_event_type_check
  CHECK (event_type = ANY (ARRAY[
    'lead_qualified', 'follow_up_sent', 'no_show_recovered', 'out_of_hours_handled',
    'objection_handled', 'reactivation_sent', 'agent_error', 'db_error', 'delivery_error',
    'run_superseded', 'run_suppressed', 'handoff_tag_on', 'handoff_tag_off',
    'channel_disabled', 'test_mode_skip', 'keyword_required', 'bot_activated',
    'availability_checked'
  ]));
