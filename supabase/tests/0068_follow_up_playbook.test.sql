-- ============================================================
-- Test — 0068: el sello de etapa en follow_ups y el cursor de ángulos por pool.
--
-- `pnpm test:unit` mockea db/queries: que la fila guarde la etapa con que se armó,
-- que el índice de ángulo lleve su pool y que la firma vieja siga resolviendo
-- (el Worker desplegado llama con 5 args) sólo se prueba aquí.
--
--   psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
--     -v ON_ERROR_STOP=1 -f supabase/tests/0068_follow_up_playbook.test.sql
--
-- Corre dentro de una transacción y hace ROLLBACK: no deja rastro.
-- ============================================================

\set ON_ERROR_STOP on
BEGIN;

DO $$
DECLARE
  v_client uuid;
  v_conv   uuid;
  v_ghl    text := 'test-0068-conv';
  v_fu     uuid;
  v_stage  text;
  v_pool   text;
  v_idx    int;
  v_n      int;
BEGIN
  SELECT t.client_id INTO v_client FROM public.tenants t LIMIT 1;
  IF v_client IS NULL THEN
    RAISE EXCEPTION 'no hay tenants sembrados — corre `supabase db reset` primero';
  END IF;

  INSERT INTO public.conversations (client_id, channel, ghl_conversation_id, ghl_contact_id, status)
  VALUES (v_client, 'whatsapp', v_ghl, 'test-0068-contact', 'active')
  RETURNING id INTO v_conv;

  -- 1. la firma de 5 args (el Worker desplegado) sigue resolviendo: etapa NULL
  v_fu := public.app_schedule_follow_up(v_conv, 1, now() - interval '1 minute', 'cadence', 0);
  ASSERT v_fu IS NOT NULL, 'la llamada de 5 args debió agendar';
  SELECT stage INTO v_stage FROM public.follow_ups WHERE id = v_fu;
  ASSERT v_stage IS NULL, format('5 args debió dejar stage NULL, quedó %s', v_stage);

  -- 2. app_load_due_follow_ups devuelve la columna stage
  SELECT count(*) INTO v_n FROM public.app_load_due_follow_ups(10) d WHERE d.follow_up_id = v_fu AND d.stage IS NULL;
  ASSERT v_n = 1, 'load_due debió devolver la fila con stage NULL';

  -- 3. mark_sent con 2 args (Worker desplegado) deja angle_pool NULL
  UPDATE public.follow_ups SET status = 'sending' WHERE id = v_fu;
  PERFORM public.app_mark_follow_up_sent(v_fu, 2);
  SELECT angle_index, angle_pool INTO v_idx, v_pool FROM public.follow_ups WHERE id = v_fu;
  ASSERT v_idx = 2 AND v_pool IS NULL, format('mark_sent 2 args: %s/%s', v_idx, v_pool);

  -- 4. la firma nueva sella la etapa y la devuelve en load_due
  v_fu := public.app_schedule_follow_up(v_conv, 2, now() - interval '1 minute', 'cadence', 0, 'NI');
  SELECT count(*) INTO v_n FROM public.app_load_due_follow_ups(10) d WHERE d.follow_up_id = v_fu AND d.stage = 'NI';
  ASSERT v_n = 1, 'load_due debió devolver stage NI';

  -- 5. mark_sent con pool guarda el pool
  UPDATE public.follow_ups SET status = 'sending' WHERE id = v_fu;
  PERFORM public.app_mark_follow_up_sent(v_fu, 0, 'interest:Botox/NI');
  SELECT angle_index, angle_pool INTO v_idx, v_pool FROM public.follow_ups WHERE id = v_fu;
  ASSERT v_idx = 0 AND v_pool = 'interest:Botox/NI', format('mark_sent 3 args: %s/%s', v_idx, v_pool);

  -- 6. una etapa inválida no rompe el agendado: queda NULL
  v_fu := public.app_schedule_follow_up(v_conv, 3, now() + interval '1 hour', 'cadence', 0, 'HOT');
  SELECT stage INTO v_stage FROM public.follow_ups WHERE id = v_fu;
  ASSERT v_fu IS NOT NULL AND v_stage IS NULL, 'una etapa inválida se ignora, no falla';

  -- 7. el CHECK rechaza una escritura directa inválida
  BEGIN
    UPDATE public.follow_ups SET stage = 'HOT' WHERE id = v_fu;
    RAISE EXCEPTION 'el CHECK de stage no disparó';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  -- 8. tenant_config.follow_up_playbook existe y acepta jsonb
  UPDATE public.tenant_config SET follow_up_playbook = '{"stages":{"NI":{"cadence":[10]}}}'::jsonb
  WHERE tenant_id = (SELECT id FROM public.tenants WHERE client_id = v_client LIMIT 1);

  RAISE NOTICE '0068 OK';
END $$;

ROLLBACK;
