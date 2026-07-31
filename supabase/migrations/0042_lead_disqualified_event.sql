-- ============================================================
-- Migration 0042 — `lead_disqualified`: WHY a lead was parked in standby
-- The Bot Crew · Agent Platform
--
-- The Bot Crew's front-desk persona now has one (and only one) disqualifier:
-- the lead's business never books appointments — the sale closes inside the
-- chat — so the system has nothing to schedule. The bot explains it warmly,
-- does NOT start a demo, and parks the conversation in `standby`.
--
-- Problem: `standby` already logs `status_changed {from,to}`, which is
-- indistinguishable from "the bot simply finished its flow". With no way to
-- separate the two you can neither count fit-disqualifications nor audit
-- whether the model is over-trimming — which is exactly what needs watching in
-- the first weeks after a disqualification rule ships.
--
-- Fix: a distinct event carrying the model's own stated reason, written from
-- `updateConversationStatus` when it is given one. Free text (capped in the
-- tool) rather than an enum ON PURPOSE: an enum would only ever record the
-- reasons we predicted, and the signal we actually want is the UNEXPECTED
-- reason — a model inventing its own grounds to disqualify. Read the payload,
-- not just the count:
--   select payload->>'reason', count(*) from bot_events
--   where event_type = 'lead_disqualified' group by 1 order by 2 desc;
--
-- Purely additive: no column, no function signature, no behavior change. The
-- currently deployed Worker never emits this type, so the constraint widening
-- is safe to apply before the deploy (expand/contract).
--
-- ROLLBACK: re-run the 0038 constraint body. Any 'lead_disqualified' rows
-- written by the newer code would violate it, so delete them first
-- (delete from bot_events where event_type = 'lead_disqualified').
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
    'demo_session_started', 'demo_session_ended', 'lead_disqualified'
  ]));
