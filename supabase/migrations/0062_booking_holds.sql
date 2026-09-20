-- ============================================================
-- Migration 0062 — booking holds: a cita counts only once the lead pays
-- The Bot Crew · Agent Platform
--
-- The offer this serves: the client gets the system for free, and the platform
-- earns a fixed amount every time one of THEIR leads confirms a cita by paying
-- for it. So the money lands on the platform's own Stripe account (one account,
-- platform-level secrets), never on the client's GHL payment provider, and the
-- flow is owned end to end by the Worker — no GHL workflow in the critical path:
--
--   bookAppointment  → GHL event born `new` ("No confirmada") + a Stripe Checkout
--                      Session + one row here (status 'pending', due_at = now +
--                      booking_payment.hold_hours). The bot pastes the checkout
--                      URL and the deadline into the chat.
--   /webhooks/stripe → checkout.session.completed → app_settle_hold_payment:
--                      pending → paid. The Worker flips the GHL event to
--                      `confirmed`, tags `cita-pagada`, fires CAPI Purchase.
--   5-min cron       → app_claim_expired_holds: pending & overdue → 'expiring'
--                      (SKIP LOCKED, the follow_ups claim idiom). The runner
--                      cancels the GHL event, expires the Stripe session, tags
--                      `apartado-vencido`, and app_finish_hold → 'expired'.
--
-- STATES. pending → paid | expiring | cancelled ; expiring → expired | pending
-- (a GHL cancel that failed goes back to pending so the next tick retries —
-- loud each time, never stuck) ; expiring|expired → paid_late (a payment that
-- lands after the slot was released: the cita is NOT resurrected, a person
-- decides — refund or rebook). The transitions live in the RPCs, not in the
-- Worker, so two callers (webhook + cron) racing on one hold can't both win.
--
-- Per tenant: tenant_config.booking_payment jsonb, NULL = feature off:
--   { "amount": 500, "currency": "mxn", "hold_hours": 24,
--     "deposit_note": "Se descuenta del costo de tu consulta.",
--     "statement_suffix": "DR VALDIVIA" }
-- amount is in pesos (the Worker converts to cents); services[].deposit
-- overrides it per service. Off for every tenant until someone sets the column.
--
-- Expand-only: nullable column + new table + new RPCs + widened CHECKs. The
-- deployed Worker reads none of it.
-- ============================================================

ALTER TABLE public.tenant_config
  ADD COLUMN IF NOT EXISTS booking_payment jsonb;

COMMENT ON COLUMN public.tenant_config.booking_payment IS
  'Paid-confirmation config ({amount (pesos), currency, hold_hours, deposit_note, statement_suffix}). NULL = citas confirm without payment (default). The money lands on the PLATFORM Stripe account.';

-- ------------------------------------------------------------
-- 1. The hold: one row per appointment the bot booked under this feature.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.booking_holds (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id             uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  ghl_conversation_id   text NOT NULL,
  ghl_contact_id        text NOT NULL,
  ghl_appointment_id    text NOT NULL UNIQUE,
  service_type          text,
  appointment_datetime  timestamptz,
  amount_cents          integer NOT NULL CHECK (amount_cents > 0),
  currency              text NOT NULL DEFAULT 'mxn',
  stripe_session_id     text NOT NULL UNIQUE,
  stripe_payment_intent text,
  checkout_url          text NOT NULL,
  status                text NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'paid', 'expiring', 'expired', 'cancelled', 'paid_late')),
  due_at                timestamptz NOT NULL,
  paid_at               timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_booking_holds_client ON public.booking_holds (client_id);
-- The cron's scan: only overdue pending rows, oldest first.
CREATE INDEX IF NOT EXISTS idx_booking_holds_due ON public.booking_holds (due_at) WHERE status = 'pending';

-- Deny-by-default (0032 rule): RLS on, zero policies. Service role bypasses.
ALTER TABLE public.booking_holds ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.booking_holds IS
  'Paid-confirmation holds (0062): one per bot booking under booking_payment. pending → paid (Stripe webhook) | expiring → expired (cron) | cancelled (lead) | paid_late (paid after release — a person decides).';

-- ------------------------------------------------------------
-- 2. Events + CAPI kind the Worker will write.
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
    -- 0062 paid confirmation
    'hold_created', 'hold_released', 'hold_expired',
    'booking_paid', 'booking_paid_late', 'payment_error'
  ]));

ALTER TABLE public.capi_events DROP CONSTRAINT IF EXISTS capi_events_kind_check;
ALTER TABLE public.capi_events ADD CONSTRAINT capi_events_kind_check
  CHECK (kind IN ('lead_started', 'appointment_booked', 'conversation_completed', 'appointment_paid'));

-- ------------------------------------------------------------
-- 3. Create. Called right after the GHL booking + Stripe session succeed.
-- ------------------------------------------------------------
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
  p_due_at               timestamptz
) RETURNS uuid
LANGUAGE sql AS $$
  INSERT INTO public.booking_holds (
    client_id, ghl_conversation_id, ghl_contact_id, ghl_appointment_id, service_type,
    appointment_datetime, amount_cents, currency, stripe_session_id, checkout_url, due_at
  ) VALUES (
    p_client_id, p_ghl_conversation_id, p_ghl_contact_id, p_ghl_appointment_id, p_service_type,
    p_appointment_datetime, p_amount_cents, lower(p_currency), p_stripe_session_id, p_checkout_url, p_due_at
  )
  RETURNING id;
$$;

-- ------------------------------------------------------------
-- 4. Settle. ONE atomic decision per Stripe session:
--    pending            → paid       (outcome 'paid')
--    expiring | expired → paid_late  (outcome 'paid_late')
--    anything else      → no row     (already settled, or cancelled: the caller ignores)
--    Returns the hold + what the caller needs to act (channel, phone, location).
--    A replayed webhook finds 'paid' and gets nothing — idempotent by construction.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.app_settle_hold_payment(
  p_stripe_session_id text,
  p_payment_intent    text
) RETURNS TABLE (
  outcome              text,
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
  due_at               timestamptz,
  channel              text,
  contact_phone        text,
  ghl_location_id      text
)
LANGUAGE plpgsql AS $$
DECLARE
  v_id      uuid;
  v_outcome text;
BEGIN
  UPDATE public.booking_holds h
  SET status = 'paid', paid_at = now(), stripe_payment_intent = p_payment_intent, updated_at = now()
  WHERE h.stripe_session_id = p_stripe_session_id AND h.status = 'pending'
  RETURNING h.id INTO v_id;
  IF v_id IS NOT NULL THEN
    v_outcome := 'paid';
  ELSE
    UPDATE public.booking_holds h
    SET status = 'paid_late', paid_at = now(), stripe_payment_intent = p_payment_intent, updated_at = now()
    WHERE h.stripe_session_id = p_stripe_session_id AND h.status IN ('expiring', 'expired')
    RETURNING h.id INTO v_id;
    IF v_id IS NULL THEN
      RETURN;
    END IF;
    v_outcome := 'paid_late';
  END IF;

  RETURN QUERY
  SELECT v_outcome, h.id, h.client_id, h.ghl_conversation_id, h.ghl_contact_id, h.ghl_appointment_id,
         h.service_type, h.appointment_datetime, h.amount_cents, h.currency, h.checkout_url, h.due_at,
         c.channel, c.contact_phone, t.ghl_location_id
  FROM public.booking_holds h
  LEFT JOIN public.conversations c
    ON c.ghl_conversation_id = h.ghl_conversation_id AND c.client_id = h.client_id
  LEFT JOIN public.tenants t
    ON t.client_id = h.client_id AND t.is_active
  WHERE h.id = v_id;
END;
$$;

-- ------------------------------------------------------------
-- 5. Claim overdue holds for the cron. pending & due → expiring, SKIP LOCKED so
--    two ticks can't both release the same slot. Same row shape as settle minus
--    outcome, so the runner and the webhook share one TS type.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.app_claim_expired_holds(p_limit integer DEFAULT 20)
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
  stripe_session_id    text,
  due_at               timestamptz,
  channel              text,
  contact_phone        text,
  ghl_location_id      text
)
LANGUAGE sql AS $$
  WITH claimed AS (
    UPDATE public.booking_holds
    SET status = 'expiring', updated_at = now()
    WHERE id IN (
      SELECT h.id FROM public.booking_holds h
      WHERE h.status = 'pending' AND h.due_at <= now()
      ORDER BY h.due_at
      LIMIT p_limit
      FOR UPDATE SKIP LOCKED
    )
    RETURNING booking_holds.id AS c_id
  )
  SELECT h.id, h.client_id, h.ghl_conversation_id, h.ghl_contact_id, h.ghl_appointment_id,
         h.service_type, h.appointment_datetime, h.amount_cents, h.currency, h.checkout_url,
         h.stripe_session_id, h.due_at, c.channel, c.contact_phone, t.ghl_location_id
  FROM claimed cl
  JOIN public.booking_holds h ON h.id = cl.c_id
  LEFT JOIN public.conversations c
    ON c.ghl_conversation_id = h.ghl_conversation_id AND c.client_id = h.client_id
  LEFT JOIN public.tenants t
    ON t.client_id = h.client_id AND t.is_active;
$$;

-- ------------------------------------------------------------
-- 6. Finish. Guarded transitions only; false = the row was not where the
--    caller thought (a payment won the race, or a double call). The caller
--    must then NOT act as if it had — e.g. not cancel a cita that just got paid.
--      'expired'   requires expiring
--      'cancelled' requires pending | expiring   (the lead cancelled)
--      'pending'   requires expiring             (GHL cancel failed → retry next tick)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.app_finish_hold(
  p_id     uuid,
  p_status text
) RETURNS boolean
LANGUAGE plpgsql AS $$
BEGIN
  IF p_status = 'expired' THEN
    UPDATE public.booking_holds SET status = 'expired', updated_at = now()
    WHERE id = p_id AND status = 'expiring';
  ELSIF p_status = 'cancelled' THEN
    UPDATE public.booking_holds SET status = 'cancelled', updated_at = now()
    WHERE id = p_id AND status IN ('pending', 'expiring');
  ELSIF p_status = 'pending' THEN
    UPDATE public.booking_holds SET status = 'pending', updated_at = now()
    WHERE id = p_id AND status = 'expiring';
  ELSE
    RAISE EXCEPTION 'app_finish_hold: unsupported target status %', p_status;
  END IF;
  RETURN FOUND;
END;
$$;

-- ------------------------------------------------------------
-- 7. Move. A reschedule keeps the hold (same link, same deadline) and only
--    updates the appointment time we mirror for reporting.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.app_move_hold(
  p_ghl_appointment_id   text,
  p_appointment_datetime timestamptz
) RETURNS boolean
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE public.booking_holds
  SET appointment_datetime = p_appointment_datetime, updated_at = now()
  WHERE ghl_appointment_id = p_ghl_appointment_id;
  RETURN FOUND;
END;
$$;

-- ------------------------------------------------------------
-- 8. The platform's revenue report: paid citas per client per month.
--    security_invoker + revoked from the Data API roles (0032 rule).
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW public.paid_bookings_monthly
WITH (security_invoker = on) AS
  SELECT h.client_id,
         cl.name                                  AS client_name,
         date_trunc('month', h.paid_at)           AS month,
         h.currency,
         count(*)                                 AS paid_count,
         sum(h.amount_cents)                      AS amount_cents,
         count(*) FILTER (WHERE h.status = 'paid_late') AS paid_late_count
  FROM public.booking_holds h
  JOIN public.clients cl ON cl.id = h.client_id
  WHERE h.status IN ('paid', 'paid_late')
  GROUP BY h.client_id, cl.name, date_trunc('month', h.paid_at), h.currency;

REVOKE ALL ON public.paid_bookings_monthly FROM anon, authenticated;

-- ------------------------------------------------------------
-- 9. Grants (0032 rule: revoke from PUBLIC, grant service_role explicitly).
-- ------------------------------------------------------------
REVOKE ALL ON FUNCTION public.app_create_booking_hold(uuid, text, text, text, text, timestamptz, integer, text, text, text, timestamptz) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.app_create_booking_hold(uuid, text, text, text, text, timestamptz, integer, text, text, text, timestamptz) TO service_role;
REVOKE ALL ON FUNCTION public.app_settle_hold_payment(text, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.app_settle_hold_payment(text, text) TO service_role;
REVOKE ALL ON FUNCTION public.app_claim_expired_holds(integer) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.app_claim_expired_holds(integer) TO service_role;
REVOKE ALL ON FUNCTION public.app_finish_hold(uuid, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.app_finish_hold(uuid, text) TO service_role;
REVOKE ALL ON FUNCTION public.app_move_hold(text, timestamptz) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.app_move_hold(text, timestamptz) TO service_role;
