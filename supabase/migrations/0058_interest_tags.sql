-- ============================================================
-- Migration 0058 — interest tags (per-treatment tags on the GHL contact)
-- The Bot Crew · Agent Platform
--
-- A tenant that opts in gets, on each contact, one `interes-<servicio>` tag per
-- configured service the lead showed interest in ("interes-botox",
-- "interes-laser-co2-fraccionado"). The service is picked by the status classifier
-- (the existing aux model call, extended with an `interest` field and the tenant's
-- `services[].name` list) and validated against that list before anything is
-- written — the model can only choose a name the tenant configured. Smart lists /
-- campaigns in GHL key on the tags; nothing in the Worker reads them back.
--
-- Per tenant: interest_tags. Default FALSE — adding tags to a client's contacts
-- unasked is a behaviour change, and with the flag on the classifier runs on EVERY
-- replied turn (today it runs only when the reply carries no question).
--
-- Expand-only: the deployed Worker neither reads the column nor writes the event.
-- ============================================================

ALTER TABLE public.tenant_config
  ADD COLUMN IF NOT EXISTS interest_tags boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.tenant_config.interest_tags IS
  'Tag the GHL contact `interes-<servicio>` for each configured service the lead shows interest in (picked by the classifier, validated against services[].name). false = off.';

-- ---------- observability ----------
-- interest_tagged: {service, tag} — written when the tag is sent to GHL. Repeats if the
-- lead keeps naming the same treatment (adding an existing tag in GHL is a no-op).
-- The list is prod's CURRENT one (0054) plus the new type.
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
    'interest_tagged'
  ]));
