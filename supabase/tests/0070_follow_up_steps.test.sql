-- ============================================================
-- Test — 0070: el sello de paso (step) en follow_ups y la vista de resultados.
--
-- `pnpm test:unit` mockea db/queries: que el paso se guarde, que la firma de
-- 3 args (el Worker desplegado) siga resolviendo, que un paso inválido quede
-- NULL y que la vista cuente respuestas sólo se prueba aquí.
--
--   psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
--     -v ON_ERROR_STOP=1 -f supabase/tests/0070_follow_up_steps.test.sql
--
-- Corre dentro de una transacción y hace ROLLBACK: no deja rastro.
-- ============================================================

\set ON_ERROR_STOP on
BEGIN;

DO $$
DECLARE
  v_client uuid;
  v_conv   uuid;
  v_fu1    uuid;
  v_fu2    uuid;
  v_step   text;
  v_sent   bigint;
  v_repl   bigint;
BEGIN
  SELECT t.client_id INTO v_client FROM public.tenants t LIMIT 1;
  IF v_client IS NULL THEN
    RAISE EXCEPTION 'no hay tenants sembrados — corre `supabase db reset` primero';
  END IF;

  INSERT INTO public.conversations (client_id, channel, ghl_conversation_id, ghl_contact_id, status)
  VALUES (v_client, 'whatsapp', 'test-0070-conv', 'test-0070-contact', 'active')
  RETURNING id INTO v_conv;

  -- 1. la firma de 3 args (Worker desplegado) sigue resolviendo: step NULL
  v_fu1 := public.app_schedule_follow_up(v_conv, 1, now() - interval '2 hours', 'cadence', 0, 'NI');
  UPDATE public.follow_ups SET status = 'sending' WHERE id = v_fu1;
  PERFORM public.app_mark_follow_up_sent(v_fu1, 0, 'stage:NI');
  SELECT step INTO v_step FROM public.follow_ups WHERE id = v_fu1;
  ASSERT v_step IS NULL, format('3 args debió dejar step NULL, quedó %s', v_step);

  -- 2. la firma nueva sella el paso
  UPDATE public.follow_ups SET status = 'sending', sent_at = NULL WHERE id = v_fu1;
  PERFORM public.app_mark_follow_up_sent(v_fu1, NULL, NULL, 'precio');
  UPDATE public.follow_ups SET sent_at = now() - interval '2 hours' WHERE id = v_fu1;
  SELECT step INTO v_step FROM public.follow_ups WHERE id = v_fu1;
  ASSERT v_step = 'precio', format('mark_sent 4 args: %s', v_step);

  -- 3. un paso que no es kebab-case se ignora, no falla
  v_fu2 := public.app_schedule_follow_up(v_conv, 2, now() - interval '1 hour', 'cadence', 0, 'NI');
  UPDATE public.follow_ups SET status = 'sending' WHERE id = v_fu2;
  PERFORM public.app_mark_follow_up_sent(v_fu2, NULL, NULL, 'Qué Esperar');
  SELECT step INTO v_step FROM public.follow_ups WHERE id = v_fu2;
  ASSERT v_step IS NULL, format('un paso inválido debió quedar NULL, quedó %s', v_step);
  UPDATE public.follow_ups SET step = 'quien', sent_at = now() - interval '1 hour' WHERE id = v_fu2;

  -- 4. el CHECK rechaza una escritura directa inválida
  BEGIN
    UPDATE public.follow_ups SET step = 'Qué Esperar' WHERE id = v_fu2;
    RAISE EXCEPTION 'el CHECK de step no disparó';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  -- 5. la vista: el lead escribió después del paso 1 y antes del paso 2 → precio replied=1, quien replied=0
  INSERT INTO public.messages (conversation_id, direction, sender_type, content, sent_at)
  VALUES (v_conv, 'inbound', 'lead', 'ok', now() - interval '90 minutes');

  SELECT sent, replied INTO v_sent, v_repl FROM public.follow_up_step_outcomes
  WHERE client_id = v_client AND stage = 'NI' AND step = 'precio';
  ASSERT v_sent = 1 AND v_repl = 1, format('precio: sent=%s replied=%s', v_sent, v_repl);

  SELECT sent, replied INTO v_sent, v_repl FROM public.follow_up_step_outcomes
  WHERE client_id = v_client AND stage = 'NI' AND step = 'quien';
  ASSERT v_sent = 1 AND v_repl = 0, format('quien: sent=%s replied=%s', v_sent, v_repl);

  -- 6. la vista no está abierta al Data API
  ASSERT NOT has_table_privilege('anon', 'public.follow_up_step_outcomes', 'SELECT'), 'anon lee la vista';
  ASSERT NOT has_table_privilege('authenticated', 'public.follow_up_step_outcomes', 'SELECT'), 'authenticated lee la vista';

  RAISE NOTICE '0070 OK';
END $$;

ROLLBACK;
