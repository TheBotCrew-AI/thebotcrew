-- ============================================================
-- Test — 0065: el recordatorio vive en el apartado y se reclama una sola vez.
--
--   psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
--     -v ON_ERROR_STOP=1 -f supabase/tests/0065_hold_reminder.test.sql
-- ============================================================

\set ON_ERROR_STOP on
BEGIN;

DO $$
DECLARE
  v_client  uuid;
  v_due     uuid;
  v_future  uuid;
  v_paid    uuid;
  v_none    uuid;
  v_n       int;
  v_ok      boolean;
BEGIN
  SELECT t.client_id INTO v_client FROM public.tenants t WHERE t.is_active LIMIT 1;
  IF v_client IS NULL THEN RAISE EXCEPTION 'no hay tenants sembrados'; END IF;

  -- recordatorio vencido y pendiente → se reclama
  v_due := public.app_create_booking_hold(v_client, 'conv-0065', 'contact-0065', 'appt-0065-a', 'Consulta',
    now() + interval '1 day', 50000, 'mxn', 'cs_0065_a', 'https://s/a', now() + interval '22 hours', 'aaaaaaaaaa', NULL, now() - interval '1 minute');
  -- recordatorio en el futuro → no
  v_future := public.app_create_booking_hold(v_client, 'conv-0065', 'contact-0065', 'appt-0065-b', 'Consulta',
    now() + interval '1 day', 50000, 'mxn', 'cs_0065_b', 'https://s/b', now() + interval '22 hours', 'bbbbbbbbbb', NULL, now() + interval '1 hour');
  -- vencido pero ya pagado → no
  v_paid := public.app_create_booking_hold(v_client, 'conv-0065', 'contact-0065', 'appt-0065-c', 'Consulta',
    now() + interval '1 day', 50000, 'mxn', 'cs_0065_c', 'https://s/c', now() + interval '22 hours', 'cccccccccc', NULL, now() - interval '1 minute');
  PERFORM public.app_settle_hold_payment('cs_0065_c', 'pi_c');
  -- sin recordatorio (la llamada de 13 args del Worker anterior) → no
  v_none := public.app_create_booking_hold(v_client, 'conv-0065', 'contact-0065', 'appt-0065-d', 'Consulta',
    now() + interval '1 day', 50000, 'mxn', 'cs_0065_d', 'https://s/d', now() + interval '22 hours', 'dddddddddd', NULL);

  SELECT count(*) INTO v_n FROM public.app_claim_due_hold_reminders(50) r WHERE r.id IN (v_due, v_future, v_paid, v_none);
  IF v_n <> 1 THEN RAISE EXCEPTION 'debe reclamarse exactamente 1 recordatorio, se reclamaron %', v_n; END IF;
  IF (SELECT reminded_at FROM public.booking_holds WHERE id = v_due) IS NULL THEN
    RAISE EXCEPTION 'el reclamo debe estampar reminded_at';
  END IF;
  IF (SELECT short_code FROM public.app_claim_due_hold_reminders(50) r WHERE r.id = v_due) IS NOT NULL THEN
    RAISE EXCEPTION 'un segundo tick no debe volver a reclamar el mismo recordatorio';
  END IF;

  -- mover: NULL conserva, p_clear_reminder borra, un valor lo cambia
  v_ok := public.app_move_hold('appt-0065-b', now() + interval '2 days');
  IF (SELECT remind_at FROM public.booking_holds WHERE id = v_future) IS NULL THEN RAISE EXCEPTION 'move sin p_remind_at debe conservar remind_at'; END IF;
  v_ok := public.app_move_hold('appt-0065-b', now() + interval '2 days', NULL, NULL, true);
  IF (SELECT remind_at FROM public.booking_holds WHERE id = v_future) IS NOT NULL THEN RAISE EXCEPTION 'p_clear_reminder debe borrar remind_at'; END IF;
  v_ok := public.app_move_hold('appt-0065-b', now() + interval '2 days', NULL, now() + interval '5 hours');
  IF (SELECT remind_at FROM public.booking_holds WHERE id = v_future) IS NULL THEN RAISE EXCEPTION 'p_remind_at debe fijar remind_at'; END IF;

  IF (SELECT count(*) FROM pg_proc WHERE proname = 'app_create_booking_hold') <> 1 THEN
    RAISE EXCEPTION 'debe existir exactamente una app_create_booking_hold';
  END IF;

  RAISE NOTICE '0065 OK';
END $$;

ROLLBACK;
