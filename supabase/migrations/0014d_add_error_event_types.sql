-- ============================================================
-- Migration 0014d — error event types for bot_events
-- The Bot Crew · Agent Platform
--
-- Backfilled from remote (version 20260613224439). Captures a change that
-- had been applied directly to production but was missing from the repo.
--
-- Order note: this resets bot_events_event_type_check to the base list. Later
-- migrations (0015 tag_handoff, 0016 channel_control, 0017 trigger_keyword_gate)
-- expand it further, so this file MUST sort BEFORE 0015 — hence the 0014d name.
-- ============================================================

ALTER TABLE public.bot_events DROP CONSTRAINT IF EXISTS bot_events_event_type_check;
ALTER TABLE public.bot_events ADD CONSTRAINT bot_events_event_type_check CHECK (
  event_type = ANY (ARRAY[
    'lead_qualified', 'follow_up_sent', 'no_show_recovered',
    'out_of_hours_handled', 'objection_handled', 'reactivation_sent',
    'agent_error', 'db_error', 'delivery_error'
  ])
);
