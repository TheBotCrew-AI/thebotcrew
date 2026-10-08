-- ============================================================
-- Migration 0066 — prime time reserved for paying services
-- The Bot Crew · Agent Platform
--
-- Business rule: the busiest hours of the week go to the appointments that pay. A lead
-- booking a restricted service (a free valoración) is first offered the slots OUTSIDE
-- those windows; the prime slots are released to them only when they say none of the
-- others works. Enforced DETERMINISTICALLY in the tools, never left to the model:
--   - getAvailability drops the prime slots for a restricted service unless the model
--     asks for them (includePrimeTime), and only with the lead's refusal on record,
--   - asking for them writes a `prime_time_released` event on the conversation,
--   - bookAppointment / rescheduleAppointment refuse a prime slot for a restricted
--     service unless that event exists (`booking_failed` reason `prime_time`).
--
-- prime_time (jsonb, NULL = feature off):
--   { "windows": [ { "days": ["mon","tue","wed","thu","fri"], "start": "17:00", "end": "20:00" } ],
--     "restricted_services": ["Valoración"] }
-- Windows are wall-clock in the tenant's timezone; a slot is prime when its START falls
-- inside a window on one of its days. `restricted_services` are exact `services[].name`.
-- Expand/contract: nullable, read by the Worker only after it ships; set per tenant after.
-- ============================================================

ALTER TABLE public.tenant_config
  ADD COLUMN IF NOT EXISTS prime_time jsonb;

COMMENT ON COLUMN public.tenant_config.prime_time IS
  'Prime-time windows ({windows:[{days,start,end}], restricted_services:[name]}) reserved for paying services; a restricted service sees them only after the lead refuses the rest. NULL = off.';

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
    -- 0066
    'prime_time_released'
  ]));
