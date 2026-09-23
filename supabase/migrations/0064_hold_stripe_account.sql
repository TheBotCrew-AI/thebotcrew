-- ============================================================
-- 0064 — Stripe Connect: the hold remembers which account its session lives on.
--
-- WHY. A tenant paid DIRECTLY (Dr. Valdivia) is a connected account of the platform's
--      Stripe; every call for its sessions carries `Stripe-Account: acct_…`. Expiring a
--      session without that header answers 404, so the account is stored ON the hold
--      when the session is created (`booking_payment.stripe_account` at that moment) —
--      a later config edit can't strand a session that already exists.
--
-- WHAT (expand-only; the deployed Worker keeps working):
--   1. booking_holds.stripe_account — NULL = the platform's own account.
--   2. app_create_booking_hold gains p_stripe_account DEFAULT NULL (the 12-arg overload is
--      dropped, same reasoning as 0063: two overloads would be ambiguous).
--   3. app_claim_expired_holds returns stripe_account (DROP + CREATE: a RETURNS TABLE
--      change). Extra column, same rows: the old Worker ignores it.
--
-- Deploy order: this migration FIRST, then the Worker.
-- ============================================================

ALTER TABLE public.booking_holds ADD COLUMN IF NOT EXISTS stripe_account text;

COMMENT ON COLUMN public.booking_holds.stripe_account IS
  '0064: Stripe Connect account (acct_…) the Checkout Session was created on, or NULL for the platform account. Every Stripe call on this session must carry it.';

DROP FUNCTION IF EXISTS public.app_create_booking_hold(uuid, text, text, text, text, timestamptz, integer, text, text, text, timestamptz, text);

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
  p_stripe_account       text DEFAULT NULL
) RETURNS uuid
LANGUAGE sql AS $$
  INSERT INTO public.booking_holds (
    client_id, ghl_conversation_id, ghl_contact_id, ghl_appointment_id, service_type,
    appointment_datetime, amount_cents, currency, stripe_session_id, checkout_url, due_at, short_code,
    stripe_account
  ) VALUES (
    p_client_id, p_ghl_conversation_id, p_ghl_contact_id, p_ghl_appointment_id, p_service_type,
    p_appointment_datetime, p_amount_cents, lower(p_currency), p_stripe_session_id, p_checkout_url, p_due_at,
    lower(p_short_code), p_stripe_account
  )
  RETURNING id;
$$;

DROP FUNCTION IF EXISTS public.app_claim_expired_holds(integer);

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
  stripe_account       text,
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
         h.stripe_session_id, h.stripe_account, h.due_at, c.channel, c.contact_phone, t.ghl_location_id
  FROM claimed cl
  JOIN public.booking_holds h ON h.id = cl.c_id
  LEFT JOIN public.conversations c
    ON c.ghl_conversation_id = h.ghl_conversation_id AND c.client_id = h.client_id
  LEFT JOIN public.tenants t
    ON t.client_id = h.client_id AND t.is_active;
$$;

REVOKE ALL ON FUNCTION public.app_create_booking_hold(uuid, text, text, text, text, timestamptz, integer, text, text, text, timestamptz, text, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.app_create_booking_hold(uuid, text, text, text, text, timestamptz, integer, text, text, text, timestamptz, text, text) TO service_role;
REVOKE ALL ON FUNCTION public.app_claim_expired_holds(integer) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.app_claim_expired_holds(integer) TO service_role;
