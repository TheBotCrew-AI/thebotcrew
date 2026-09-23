-- ============================================================
-- Test — 0064: el apartado recuerda en qué cuenta de Stripe vive su sesión.
--
-- Con cuenta conectada (Connect) se guarda; sin ella queda NULL (la cuenta de la
-- plataforma). El cron la recibe en app_claim_expired_holds para poder expirar la
-- sesión con el header correcto. La llamada de 12 argumentos (el Worker anterior)
-- sigue siendo válida.
--
--   psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
--     -v ON_ERROR_STOP=1 -f supabase/tests/0064_hold_stripe_account.test.sql
-- ============================================================

\set ON_ERROR_STOP on
BEGIN;

DO $$
DECLARE
  v_client  uuid;
  v_hold    uuid;
  v_acct    text;
  v_claimed text;
BEGIN
  SELECT t.client_id INTO v_client FROM public.tenants t WHERE t.is_active LIMIT 1;
  IF v_client IS NULL THEN
    RAISE EXCEPTION 'no hay tenants sembrados — corre `supabase db reset` primero';
  END IF;

  -- 1. Con cuenta conectada, ya vencido: se guarda y el cron la recibe.
  v_hold := public.app_create_booking_hold(
    v_client, 'conv-0064', 'contact-0064', 'appt-0064-a', 'Consulta',
    now() + interval '1 hour', 50000, 'mxn', 'cs_0064_a', 'https://checkout.stripe.com/a',
    now() - interval '1 minute', 'abcdefghjk', 'acct_1UIf7kBByPT1k8lc');
  SELECT stripe_account INTO v_acct FROM public.booking_holds WHERE id = v_hold;
  IF v_acct <> 'acct_1UIf7kBByPT1k8lc' THEN
    RAISE EXCEPTION 'stripe_account debe guardarse, quedó %', v_acct;
  END IF;
  SELECT stripe_account INTO v_claimed FROM public.app_claim_expired_holds(50) WHERE id = v_hold;
  IF v_claimed IS DISTINCT FROM 'acct_1UIf7kBByPT1k8lc' THEN
    RAISE EXCEPTION 'app_claim_expired_holds debe devolver stripe_account, devolvió %', v_claimed;
  END IF;

  -- 2. La llamada de 12 argumentos (Worker anterior): NULL = cuenta de la plataforma.
  v_hold := public.app_create_booking_hold(
    v_client, 'conv-0064', 'contact-0064', 'appt-0064-b', 'Consulta',
    now() + interval '3 days', 50000, 'mxn', 'cs_0064_b', 'https://checkout.stripe.com/b',
    now() + interval '1 day', 'bcdefghjkm');
  IF (SELECT stripe_account FROM public.booking_holds WHERE id = v_hold) IS NOT NULL THEN
    RAISE EXCEPTION 'sin p_stripe_account debe quedar NULL';
  END IF;

  -- 3. Una sola app_create_booking_hold (sin overloads ambiguos).
  IF (SELECT count(*) FROM pg_proc WHERE proname = 'app_create_booking_hold') <> 1 THEN
    RAISE EXCEPTION 'debe existir exactamente una app_create_booking_hold';
  END IF;

  RAISE NOTICE '0064 OK';
END $$;

ROLLBACK;
