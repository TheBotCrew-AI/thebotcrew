-- ============================================================
-- Test — 0063: la liga corta vive en la fila del apartado.
--
-- El Worker genera el código; la DB lo guarda en minúsculas, lo exige único cuando
-- existe y lo deja NULL para los apartados anteriores (y para el Worker viejo, que
-- llama al RPC con 11 argumentos). app_move_hold acepta un nuevo plazo y, sin él,
-- conserva el que tenía.
--
--   psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
--     -v ON_ERROR_STOP=1 -f supabase/tests/0063_hold_short_code.test.sql
--
-- Corre dentro de una transacción y hace ROLLBACK: no deja rastro.
-- ============================================================

\set ON_ERROR_STOP on
BEGIN;

DO $$
DECLARE
  v_client  uuid;
  v_hold    uuid;
  v_hold2   uuid;
  v_code    text;
  v_due     timestamptz;
  v_ok      boolean;
  v_dup     boolean := false;
BEGIN
  SELECT t.client_id INTO v_client FROM public.tenants t WHERE t.is_active LIMIT 1;
  IF v_client IS NULL THEN
    RAISE EXCEPTION 'no hay tenants sembrados — corre `supabase db reset` primero';
  END IF;

  -- 1. Con código: se guarda en minúsculas.
  v_hold := public.app_create_booking_hold(
    v_client, 'conv-0063', 'contact-0063', 'appt-0063-a', 'Consulta',
    now() + interval '3 days', 50000, 'MXN', 'cs_0063_a', 'https://checkout.stripe.com/a',
    now() + interval '1 day', 'X7K2M9QWAB');
  SELECT short_code, due_at INTO v_code, v_due FROM public.booking_holds WHERE id = v_hold;
  IF v_code <> 'x7k2m9qwab' THEN
    RAISE EXCEPTION 'el código debe guardarse en minúsculas, quedó %', v_code;
  END IF;

  -- 2. Sin código (la llamada del Worker anterior, 11 argumentos): NULL, y dos NULL conviven.
  v_hold2 := public.app_create_booking_hold(
    v_client, 'conv-0063', 'contact-0063', 'appt-0063-b', 'Consulta',
    now() + interval '3 days', 50000, 'mxn', 'cs_0063_b', 'https://checkout.stripe.com/b',
    now() + interval '1 day');
  PERFORM public.app_create_booking_hold(
    v_client, 'conv-0063', 'contact-0063', 'appt-0063-c', 'Consulta',
    now() + interval '3 days', 50000, 'mxn', 'cs_0063_c', 'https://checkout.stripe.com/c',
    now() + interval '1 day');
  IF (SELECT short_code FROM public.booking_holds WHERE id = v_hold2) IS NOT NULL THEN
    RAISE EXCEPTION 'sin p_short_code el código debe quedar NULL';
  END IF;

  -- 3. Repetido (aun con otra capitalización): lo rechaza el índice único.
  BEGIN
    PERFORM public.app_create_booking_hold(
      v_client, 'conv-0063', 'contact-0063', 'appt-0063-d', 'Consulta',
      now() + interval '3 days', 50000, 'mxn', 'cs_0063_d', 'https://checkout.stripe.com/d',
      now() + interval '1 day', 'x7k2m9qwab');
  EXCEPTION WHEN unique_violation THEN
    v_dup := true;
  END;
  IF NOT v_dup THEN
    RAISE EXCEPTION 'un código repetido debe fallar con unique_violation';
  END IF;

  -- 4. Mover sin plazo conserva el plazo; mover con plazo lo cambia.
  v_ok := public.app_move_hold('appt-0063-a', now() + interval '4 days');
  IF NOT v_ok OR (SELECT due_at FROM public.booking_holds WHERE id = v_hold) <> v_due THEN
    RAISE EXCEPTION 'app_move_hold sin p_due_at debe conservar due_at';
  END IF;
  v_ok := public.app_move_hold('appt-0063-a', now() + interval '2 hours', now() + interval '1 hour');
  IF NOT v_ok OR (SELECT due_at FROM public.booking_holds WHERE id = v_hold) = v_due THEN
    RAISE EXCEPTION 'app_move_hold con p_due_at debe cambiar due_at';
  END IF;

  -- 5. El RPC viejo de 11 argumentos ya no existe como función aparte (sería ambiguo).
  IF (SELECT count(*) FROM pg_proc WHERE proname = 'app_create_booking_hold') <> 1 THEN
    RAISE EXCEPTION 'debe existir exactamente una app_create_booking_hold';
  END IF;

  RAISE NOTICE '0063 OK';
END $$;

ROLLBACK;
