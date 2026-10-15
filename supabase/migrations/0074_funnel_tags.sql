-- ============================================================
-- Migration 0074 — funnel tags from appointment status
-- The Bot Crew · Agent Platform
--
-- The client's GHL workflows wrote the funnel tags (`agendo:`, `valorado`, `noshow:`,
-- `paciente:`) with one branch per calendar. The appointment webhook now does it,
-- generically per tenant, from ONE GHL workflow ("Appointment Status", any calendar,
-- any status → webhook with `action` = the status): the handler verifies the status
-- live with GHL, maps the calendar through this config and writes tags + date fields
-- on the contact. core/funnel-tags.ts is the table; this is its config.
--
--   tenant_config.funnel_tags jsonb, NULL = off:
--   {
--     "enabled": true,
--     "calendars": {
--       "<calendarId>": {"slug": "valoracion", "kind": "assessment"},
--       "<calendarId>": {"slug": "botox",      "kind": "treatment"}
--     },
--     "fields": {                       -- GHL custom-field IDs (never names)
--       "last_visit": "<fieldId>",      -- "ultima-visita"
--       "last_treatment": {"botox": "<fieldId>"}   -- "ultimo-botox"; a slug without one writes nothing
--     }
--   }
--
-- A calendar outside the map is ignored with a log line. `cancelled` keeps its 0049
-- behaviour (`cita-cancelada`) and touches no funnel tag.
--
-- Dedupe lives in bot_events (`appointment_status {appointmentId, status}`), NOT in
-- `appointments`: a showed/noshow row there would double the booked counts the
-- reports read. Expand-only; the deployed Worker ignores the column.
--
-- ROLLBACK: drop the column; restore the 0073 bot_events CHECK.
-- ============================================================

ALTER TABLE public.tenant_config
  ADD COLUMN IF NOT EXISTS funnel_tags jsonb;

COMMENT ON COLUMN public.tenant_config.funnel_tags IS
  'Funnel tags from appointment status (0074): {enabled, calendars:{<calendarId>:{slug,kind:assessment|treatment}}, fields:{last_visit:<fieldId>, last_treatment:{<slug>:<fieldId>}}}. NULL = off. Read by worker/appointment-webhook-handler.ts through core/funnel-tags.ts. Field values are GHL custom-field IDs, never names.';

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
    'hold_created', 'hold_released', 'hold_expired', 'booking_paid', 'booking_paid_late',
    'payment_error', 'hold_reminder_sent',
    'prime_time_released',
    'stage_changed',
    'courtesy_skipped',
    'variant_expired',
    'zone_tagged', 'objection_tagged', 'segment_note_added',
    'no_promos_on', 'no_promos_off',
    'appointment_status', 'funnel_tagged', 'funnel_error'
  ]));

-- The dedupe lookup: (client, type, appointmentId, status) through the jsonb.
CREATE INDEX IF NOT EXISTS bot_events_appointment_status_idx
  ON public.bot_events ((metadata->>'appointmentId'), (metadata->>'status'))
  WHERE event_type = 'appointment_status';

-- ------------------------------------------------------------
-- Seeds. Novobelle (Leo's test sub-account): ON, its one calendar is the assessment —
-- the e2e runs there first. Heriberto: the five calendars mapped but `enabled: false`
-- until the e2e passes and the field ids are filled in (no-ops on a local DB).
-- ------------------------------------------------------------
UPDATE public.tenant_config
   SET funnel_tags = '{"enabled": true, "calendars": {"mlMYzVVPNMFIVB4Dq06v": {"slug": "valoracion", "kind": "assessment"}}, "fields": {}}'::jsonb
 WHERE business_name = 'Novobelle' AND funnel_tags IS NULL;

UPDATE public.tenant_config
   SET funnel_tags = '{
     "enabled": false,
     "calendars": {
       "qh8yxxSnb4DAo72obVmG": {"slug": "valoracion",        "kind": "assessment"},
       "mj7foCMMIU7FBkmcN5qj": {"slug": "botox",             "kind": "treatment"},
       "PO62wtXWvdkx6cD082OO": {"slug": "laser-co2",         "kind": "treatment"},
       "wcLo7ExLFl4x48WeWKwC": {"slug": "pdrn-salmon",       "kind": "treatment"},
       "I8Xmrblh6qfyaicQMl6T": {"slug": "acido-hialuronico", "kind": "treatment"}
     },
     "fields": {"last_treatment": {}}
   }'::jsonb
 WHERE business_name = 'Dr. Heriberto Valdivia' AND funnel_tags IS NULL;
