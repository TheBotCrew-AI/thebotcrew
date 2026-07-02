-- ============================================================
-- Migration 0027 — turn_scheduled observability event
-- The Bot Crew · Agent Platform
--
-- Phase 1 of the Durable Objects migration routes the debounced turn to the
-- per-conversation Durable Object. handleInboundWebhook logs a 'turn_scheduled'
-- event when it hands the turn to the DO, so the durable-turn path is visible in
-- bot_events during (and after) rollout. Add it to the event_type check constraint
-- (the DO path was silently failing this insert until now).
-- ============================================================

ALTER TABLE public.bot_events DROP CONSTRAINT IF EXISTS bot_events_event_type_check;
ALTER TABLE public.bot_events ADD CONSTRAINT bot_events_event_type_check
  CHECK (event_type = ANY (ARRAY[
    'lead_qualified', 'follow_up_sent', 'no_show_recovered', 'out_of_hours_handled',
    'objection_handled', 'reactivation_sent', 'agent_error', 'db_error', 'delivery_error',
    'run_superseded', 'run_suppressed', 'handoff_tag_on', 'handoff_tag_off',
    'channel_disabled', 'test_mode_skip', 'keyword_required', 'bot_activated',
    'availability_checked', 'booking_failed', 'status_changed', 'turn_scheduled'
  ]));
