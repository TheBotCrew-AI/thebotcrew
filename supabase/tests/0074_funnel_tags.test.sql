-- ============================================================
-- Test — 0074: funnel_tags nace NULL, los eventos nuevos pasan el CHECK, y la llave
-- de dedupe (appointment_status por appointmentId+status en el jsonb) se encuentra.
--
--   psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
--     -v ON_ERROR_STOP=1 -f supabase/tests/0074_funnel_tags.test.sql
--
-- Corre dentro de una transacción y hace ROLLBACK: no deja rastro.
-- ============================================================

\set ON_ERROR_STOP on
BEGIN;

DO $$
DECLARE
  v_client uuid;
  v_evt text;
  v_n int;
BEGIN
  SELECT id INTO v_client FROM public.clients LIMIT 1;
  IF v_client IS NULL THEN
    RAISE EXCEPTION 'no hay clients sembrados — corre `supabase db reset` primero';
  END IF;

  -- ---------- 1. la columna existe y nace NULL (off) ----------
  ASSERT (SELECT bool_and(funnel_tags IS NULL) FROM public.tenant_config WHERE business_name NOT IN ('Novobelle', 'Dr. Heriberto Valdivia')),
    'funnel_tags debe nacer NULL fuera de los dos seeds';

  -- ---------- 2. eventos nuevos ----------
  FOREACH v_evt IN ARRAY ARRAY['appointment_status', 'funnel_tagged', 'funnel_error'] LOOP
    INSERT INTO public.bot_events (client_id, event_type, metadata) VALUES (v_client, v_evt, '{}'::jsonb);
  END LOOP;

  -- ---------- 3. la llave de dedupe: misma cita, distinto status, se distinguen ----------
  INSERT INTO public.bot_events (client_id, event_type, metadata)
  VALUES (v_client, 'appointment_status', '{"appointmentId":"appt-x","status":"scheduled"}'::jsonb);

  SELECT count(*) INTO v_n FROM public.bot_events
   WHERE client_id = v_client AND event_type = 'appointment_status'
     AND metadata @> '{"appointmentId":"appt-x","status":"scheduled"}'::jsonb;
  ASSERT v_n = 1, 'scheduled debió encontrarse una vez';

  SELECT count(*) INTO v_n FROM public.bot_events
   WHERE client_id = v_client AND event_type = 'appointment_status'
     AND metadata @> '{"appointmentId":"appt-x","status":"showed"}'::jsonb;
  ASSERT v_n = 0, 'showed de la misma cita NO debe contar como aplicado';

  BEGIN
    INSERT INTO public.bot_events (client_id, event_type, metadata)
    VALUES (v_client, 'not_a_real_event', '{}'::jsonb);
    RAISE EXCEPTION 'el CHECK de event_type dejó pasar un tipo inventado';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;

  RAISE NOTICE '0074 ok';
END $$;

ROLLBACK;
