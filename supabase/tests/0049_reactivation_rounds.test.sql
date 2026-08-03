-- ============================================================
-- Test — 0049: rondas de reactivación (front-load + taper + stop).
--
-- Los invariantes viven en SQL — cuándo se consume una ronda, que una fila
-- vieja no la regrese, que el reset no toque nada más — y `pnpm test:unit`
-- mockea db/queries, así que esto es lo único que los prueba de verdad.
--
--   psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
--     -v ON_ERROR_STOP=1 -f supabase/tests/0049_reactivation_rounds.test.sql
--
-- Corre dentro de una transacción y hace ROLLBACK: repetible sin resetear.
-- ============================================================

\set ON_ERROR_STOP on
BEGIN;

DO $$
DECLARE
  v_client uuid;
  v_conv   uuid;
  v_ghl    text := 'test-0049-conv';
  v_fu     uuid;
  v_fu2    uuid;
  v_round  int;
  v_fu_round int;
  v_count  int;
BEGIN
  -- Vía tenants: app_load_due_follow_ups hace JOIN a tenants, así que un client
  -- sin tenant haría invisible el claim (y LIMIT 1 sobre clients puede agarrar uno).
  SELECT t.client_id INTO v_client FROM public.tenants t LIMIT 1;
  IF v_client IS NULL THEN
    RAISE EXCEPTION 'no hay tenants sembrados — corre `supabase db reset` primero';
  END IF;

  INSERT INTO public.conversations (client_id, channel, ghl_conversation_id, ghl_contact_id, status)
  VALUES (v_client, 'whatsapp', v_ghl, 'test-0049-contact', 'active')
  RETURNING id INTO v_conv;

  -- ---------- 1. el overload de 5 args estampa la ronda y sigue exigiendo 'active' ----------
  v_fu := public.app_schedule_follow_up(v_conv, 1, now() - interval '1 minute', 'cadence', 2);
  ASSERT v_fu IS NOT NULL, 'no se agendó el follow-up con ronda';
  SELECT round INTO v_fu_round FROM public.follow_ups WHERE id = v_fu;
  ASSERT v_fu_round = 2, format('la fila debió quedar en ronda 2, quedó en %s', v_fu_round);

  UPDATE public.conversations SET status = 'standby' WHERE id = v_conv;
  ASSERT public.app_schedule_follow_up(v_conv, 1, now(), 'cadence', 0) IS NULL,
    'se agendó un follow-up con ronda a una conversación no activa';
  UPDATE public.conversations SET status = 'active' WHERE id = v_conv;

  -- ---------- 2. app_load_due_follow_ups devuelve la ronda de la fila ----------
  SELECT round INTO v_fu_round FROM public.app_load_due_follow_ups(20)
  WHERE follow_up_id = v_fu;
  ASSERT v_fu_round = 2, format('load devolvió ronda %s, se esperaba 2', v_fu_round);
  -- (la fila quedó en 'processing' por el claim)

  -- ---------- 3. marcar sent en tier 1 cadence CONSUME la ronda (GREATEST) ----------
  UPDATE public.follow_ups SET status = 'sending' WHERE id = v_fu;
  PERFORM public.app_mark_follow_up_sent(v_fu, NULL);
  SELECT reactivation_round INTO v_round FROM public.conversations WHERE id = v_conv;
  ASSERT v_round = 3, format('mandar el rung 1 de la ronda 2 debió dejar el contador en 3, quedó %s', v_round);

  -- ...y una fila VIEJA (ronda 0) que aterrice después no lo regresa.
  v_fu2 := public.app_schedule_follow_up(v_conv, 1, now(), 'cadence', 0);
  UPDATE public.follow_ups SET status = 'sending' WHERE id = v_fu2;
  PERFORM public.app_mark_follow_up_sent(v_fu2, NULL);
  SELECT reactivation_round INTO v_round FROM public.conversations WHERE id = v_conv;
  ASSERT v_round = 3, format('una fila vieja de ronda 0 regresó el contador a %s', v_round);

  -- ---------- 4. tier 2 y demo no consumen ronda ----------
  UPDATE public.conversations SET reactivation_round = 0 WHERE id = v_conv;

  v_fu := public.app_schedule_follow_up(v_conv, 2, now(), 'cadence', 0);
  UPDATE public.follow_ups SET status = 'sending' WHERE id = v_fu;
  PERFORM public.app_mark_follow_up_sent(v_fu, NULL);
  SELECT reactivation_round INTO v_round FROM public.conversations WHERE id = v_conv;
  ASSERT v_round = 0, format('un tier 2 consumió ronda (%s)', v_round);

  v_fu := public.app_schedule_follow_up(v_conv, 1, now(), 'demo', 0);
  UPDATE public.follow_ups SET status = 'sending' WHERE id = v_fu;
  PERFORM public.app_mark_follow_up_sent(v_fu, NULL);
  SELECT reactivation_round INTO v_round FROM public.conversations WHERE id = v_conv;
  ASSERT v_round = 0, format('un demo reminder consumió ronda (%s)', v_round);

  -- ---------- 5. el gate 0043 sigue: sin 'sending' no hay sent NI consumo ----------
  v_fu := public.app_schedule_follow_up(v_conv, 1, now(), 'cadence', 0);
  -- la fila está 'pending', no 'sending'
  PERFORM public.app_mark_follow_up_sent(v_fu, NULL);
  SELECT count(*) INTO v_count FROM public.follow_ups WHERE id = v_fu AND status = 'sent';
  ASSERT v_count = 0, 'una fila sin gate (pending) se marcó sent';
  SELECT reactivation_round INTO v_round FROM public.conversations WHERE id = v_conv;
  ASSERT v_round = 0, format('una fila cancelada/abortada consumió ronda (%s)', v_round);

  -- ---------- 6. el reset y la reactivación normal ----------
  UPDATE public.conversations SET reactivation_round = 2 WHERE id = v_conv;
  PERFORM public.app_reset_reactivation_round(v_ghl);
  SELECT reactivation_round INTO v_round FROM public.conversations WHERE id = v_conv;
  ASSERT v_round = 0, format('el reset dejó el contador en %s', v_round);

  -- app_reactivate_conversation NO toca el contador (la ronda sobrevive al standby).
  UPDATE public.conversations SET status = 'standby', reactivation_round = 1 WHERE id = v_conv;
  PERFORM public.app_reactivate_conversation(v_ghl);
  SELECT reactivation_round INTO v_round FROM public.conversations WHERE id = v_conv;
  ASSERT v_round = 1, format('reactivar la conversación tocó el contador (%s)', v_round);

  -- ---------- 7. contrato de overloads: 4 args vive (ronda 0), 3 args murió ----------
  v_fu := public.app_schedule_follow_up(v_conv, 1, now(), 'cadence');
  ASSERT v_fu IS NOT NULL, 'el overload de 4 args dejó de funcionar (el Worker desplegado lo usa)';
  SELECT round INTO v_fu_round FROM public.follow_ups WHERE id = v_fu;
  ASSERT v_fu_round = 0, format('el overload de 4 args debió insertar ronda 0, insertó %s', v_fu_round);

  SELECT count(*) INTO v_count FROM pg_proc
  WHERE proname = 'app_schedule_follow_up'
    AND pronamespace = 'public'::regnamespace
    AND pronargs = 3;
  ASSERT v_count = 0, 'el overload de 3 args (0012) sigue vivo — 0049 debió tirarlo';

  -- ---------- 8. reactivation_exhausted pasa el check de bot_events ----------
  INSERT INTO public.bot_events (client_id, conversation_id, event_type, metadata)
  VALUES (v_client, v_conv, 'reactivation_exhausted', '{"round": 2}'::jsonb);

  RAISE NOTICE 'OK — 0049: rondas de reactivación (8 casos)';
END $$;

ROLLBACK;
