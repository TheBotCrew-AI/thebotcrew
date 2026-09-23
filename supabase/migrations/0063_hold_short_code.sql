-- ============================================================
-- 0063 — hold short code: the lead gets <WORKER_URL>/p/<code>, never Stripe's URL.
--
-- WHY. Stripe's Checkout URL is ~300 characters plus a `#fragment`, and the model copies
--      it by hand into its reply. On 2026-09-22 it pasted the fragment twice (dead link)
--      and dragged the tool's own instructions into the message. A 10-character code the
--      Worker redirects (`GET /p/:code`) is short enough to copy and, unlike Stripe's URL,
--      can say "ya está pagado" / "venció" once the hold moved on.
--
-- WHAT.
--   1. booking_holds.short_code — nullable (expand/contract: holds created by the Worker
--      deployed before this keep NULL and their Stripe URL keeps working), unique when set.
--      Stored lowercase; the Worker generates it (crypto), the DB only stores it.
--   2. app_create_booking_hold gains p_short_code DEFAULT NULL. The 11-arg overload is
--      DROPPED in the same step: keeping both would make an 11-named-arg call ambiguous
--      ("could not choose a best candidate function"), whereas a DEFAULT on the 12th
--      keeps the old Worker's 11-arg call valid.
--   3. app_move_hold gains p_due_at DEFAULT NULL: a reschedule to a sooner cita may need
--      to pull the deadline in (the deadline must stay before the cita — see 0063 in
--      business-logic §5e); NULL keeps the deadline as it is (the old Worker's call).
--
-- Deploy order: this migration FIRST (harmless to the old Worker), then the Worker.
-- ============================================================

ALTER TABLE public.booking_holds ADD COLUMN IF NOT EXISTS short_code text;

CREATE UNIQUE INDEX IF NOT EXISTS booking_holds_short_code_key
  ON public.booking_holds (short_code) WHERE short_code IS NOT NULL;

COMMENT ON COLUMN public.booking_holds.short_code IS
  '0063: 10-char lowercase code behind the short payment link <WORKER_URL>/p/<code> (the Worker redirects to checkout_url while pending). NULL = hold created before 0063, the lead has the Stripe URL.';

-- ------------------------------------------------------------
-- Create: same as 0062 plus the code. lower() so a lookup by lower(code) always hits.
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS public.app_create_booking_hold(uuid, text, text, text, text, timestamptz, integer, text, text, text, timestamptz);

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
  p_short_code           text DEFAULT NULL
) RETURNS uuid
LANGUAGE sql AS $$
  INSERT INTO public.booking_holds (
    client_id, ghl_conversation_id, ghl_contact_id, ghl_appointment_id, service_type,
    appointment_datetime, amount_cents, currency, stripe_session_id, checkout_url, due_at, short_code
  ) VALUES (
    p_client_id, p_ghl_conversation_id, p_ghl_contact_id, p_ghl_appointment_id, p_service_type,
    p_appointment_datetime, p_amount_cents, lower(p_currency), p_stripe_session_id, p_checkout_url, p_due_at,
    lower(p_short_code)
  )
  RETURNING id;
$$;

-- ------------------------------------------------------------
-- Move: the reschedule may also pull the deadline in. NULL = keep it.
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS public.app_move_hold(text, timestamptz);

CREATE OR REPLACE FUNCTION public.app_move_hold(
  p_ghl_appointment_id   text,
  p_appointment_datetime timestamptz,
  p_due_at               timestamptz DEFAULT NULL
) RETURNS boolean
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE public.booking_holds
  SET appointment_datetime = p_appointment_datetime,
      due_at = COALESCE(p_due_at, due_at),
      updated_at = now()
  WHERE ghl_appointment_id = p_ghl_appointment_id;
  RETURN FOUND;
END;
$$;

-- ------------------------------------------------------------
-- Grants (0032 rule: revoke from PUBLIC, grant service_role explicitly).
-- ------------------------------------------------------------
REVOKE ALL ON FUNCTION public.app_create_booking_hold(uuid, text, text, text, text, timestamptz, integer, text, text, text, timestamptz, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.app_create_booking_hold(uuid, text, text, text, text, timestamptz, integer, text, text, text, timestamptz, text) TO service_role;
REVOKE ALL ON FUNCTION public.app_move_hold(text, timestamptz, timestamptz) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.app_move_hold(text, timestamptz, timestamptz) TO service_role;
