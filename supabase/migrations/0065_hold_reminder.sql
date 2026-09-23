-- ============================================================
-- 0065 — one pre-deadline reminder per paid hold.
--
-- WHY. A lead who got the payment link and went quiet loses the slot at the
--      deadline with no warning. One reminder, LLM-free, timed from the hold's own
--      deadline and kept out of the quiet window (business-logic §5e) — never a
--      fixed hour.
--
-- WHAT (expand-only). The reminder lives ON the hold, not in follow_ups: a
--      follow-up row is cancelled by any inbound and gated on status='active', and
--      a booked conversation is 'completed' — the wrong semantics for a reminder
--      that must survive "gracias" and fire after the booking closed the thread.
--   1. booking_holds.remind_at (when; NULL = none) + reminded_at (claimed/sent).
--   2. app_create_booking_hold gains p_remind_at DEFAULT NULL (13-arg overload dropped).
--   3. app_move_hold gains p_remind_at + p_clear_reminder: a reschedule recomputes.
--   4. app_claim_due_hold_reminders(p_limit): pending & remind_at <= now & not yet
--      reminded → reminded_at = now(), returns the rows with what the sender needs.
--      SKIP LOCKED, so two ticks can't send twice. Only `pending` rows: a paid,
--      expired or cancelled hold is silently never reminded.
--   5. bot_events gains 'hold_reminder_sent'.
-- ============================================================

ALTER TABLE public.booking_holds ADD COLUMN IF NOT EXISTS remind_at timestamptz;
ALTER TABLE public.booking_holds ADD COLUMN IF NOT EXISTS reminded_at timestamptz;

COMMENT ON COLUMN public.booking_holds.remind_at IS
  '0065: when the one pre-deadline reminder goes out (computed from due_at, kept out of quiet hours). NULL = no reminder fits.';
COMMENT ON COLUMN public.booking_holds.reminded_at IS
  '0065: set atomically when the 5-min cron claims the reminder; NULL until then.';

CREATE INDEX IF NOT EXISTS idx_booking_holds_remind
  ON public.booking_holds (remind_at) WHERE status = 'pending' AND reminded_at IS NULL AND remind_at IS NOT NULL;

-- ------------------------------------------------------------
-- Create (+ remind_at)
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS public.app_create_booking_hold(uuid, text, text, text, text, timestamptz, integer, text, text, text, timestamptz, text, text);

CREATE OR REPLACE FUNCTION public.app_create_booking_hold(
  p_client_id            uuid,
  p_ghl_conversation_id  text,
  p_ghl_contact_id       text,
  p_ghl_appointment_id   text,
  p_service_type         text,
  p_appointment_datetime timestamptz,
  p_amount_cents         integer,
  p_currency             text,
  p_stripe_session_id    text,
  p_checkout_url         text,
  p_due_at               timestamptz,
  p_short_code           text DEFAULT NULL,
  p_stripe_account       text DEFAULT NULL,
  p_remind_at            timestamptz DEFAULT NULL
) RETURNS uuid
LANGUAGE sql AS $$
  INSERT INTO public.booking_holds (
    client_id, ghl_conversation_id, ghl_contact_id, ghl_appointment_id, service_type,
    appointment_datetime, amount_cents, currency, stripe_session_id, checkout_url, due_at, short_code,
    stripe_account, remind_at
  ) VALUES (
    p_client_id, p_ghl_conversation_id, p_ghl_contact_id, p_ghl_appointment_id, p_service_type,
    p_appointment_datetime, p_amount_cents, lower(p_currency), p_stripe_session_id, p_checkout_url, p_due_at,
    lower(p_short_code), p_stripe_account, p_remind_at
  )
  RETURNING id;
$$;

-- ------------------------------------------------------------
-- Move (+ remind_at / clear). NULL p_remind_at keeps it; p_clear_reminder drops it.
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS public.app_move_hold(text, timestamptz, timestamptz);

CREATE OR REPLACE FUNCTION public.app_move_hold(
  p_ghl_appointment_id   text,
  p_appointment_datetime timestamptz,
  p_due_at               timestamptz DEFAULT NULL,
  p_remind_at            timestamptz DEFAULT NULL,
  p_clear_reminder       boolean DEFAULT false
) RETURNS boolean
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE public.booking_holds
  SET appointment_datetime = p_appointment_datetime,
      due_at = COALESCE(p_due_at, due_at),
      remind_at = CASE WHEN p_clear_reminder THEN NULL ELSE COALESCE(p_remind_at, remind_at) END,
      updated_at = now()
  WHERE ghl_appointment_id = p_ghl_appointment_id;
  RETURN FOUND;
END;
$$;

-- ------------------------------------------------------------
-- Claim due reminders for the cron. Same row shape as app_claim_expired_holds
-- plus short_code (the link the reminder repeats).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.app_claim_due_hold_reminders(p_limit integer DEFAULT 20)
RETURNS TABLE (
  id                   uuid,
  client_id            uuid,
  ghl_conversation_id  text,
  ghl_contact_id       text,
  ghl_appointment_id   text,
  service_type         text,
  appointment_datetime timestamptz,
  amount_cents         integer,
  currency             text,
  checkout_url         text,
  short_code           text,
  stripe_session_id    text,
  stripe_account       text,
  due_at               timestamptz,
  channel              text,
  contact_phone        text,
  ghl_location_id      text
)
LANGUAGE sql AS $$
  WITH claimed AS (
    UPDATE public.booking_holds
    SET reminded_at = now(), updated_at = now()
    WHERE id IN (
      SELECT h.id FROM public.booking_holds h
      WHERE h.status = 'pending' AND h.reminded_at IS NULL
        AND h.remind_at IS NOT NULL AND h.remind_at <= now()
      ORDER BY h.remind_at
      LIMIT p_limit
      FOR UPDATE SKIP LOCKED
    )
    RETURNING booking_holds.id AS c_id
  )
  SELECT h.id, h.client_id, h.ghl_conversation_id, h.ghl_contact_id, h.ghl_appointment_id,
         h.service_type, h.appointment_datetime, h.amount_cents, h.currency, h.checkout_url,
         h.short_code, h.stripe_session_id, h.stripe_account, h.due_at, c.channel, c.contact_phone, t.ghl_location_id
  FROM claimed cl
  JOIN public.booking_holds h ON h.id = cl.c_id
  LEFT JOIN public.conversations c
    ON c.ghl_conversation_id = h.ghl_conversation_id AND c.client_id = h.client_id
  LEFT JOIN public.tenants t
    ON t.client_id = h.client_id AND t.is_active;
$$;

-- ------------------------------------------------------------
-- Event type
-- ------------------------------------------------------------
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
    -- 0065
    'hold_reminder_sent'
  ]));

-- ------------------------------------------------------------
-- Grants (0032 rule)
-- ------------------------------------------------------------
REVOKE ALL ON FUNCTION public.app_create_booking_hold(uuid, text, text, text, text, timestamptz, integer, text, text, text, timestamptz, text, text, timestamptz) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.app_create_booking_hold(uuid, text, text, text, text, timestamptz, integer, text, text, text, timestamptz, text, text, timestamptz) TO service_role;
REVOKE ALL ON FUNCTION public.app_move_hold(text, timestamptz, timestamptz, timestamptz, boolean) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.app_move_hold(text, timestamptz, timestamptz, timestamptz, boolean) TO service_role;
REVOKE ALL ON FUNCTION public.app_claim_due_hold_reminders(integer) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.app_claim_due_hold_reminders(integer) TO service_role;
