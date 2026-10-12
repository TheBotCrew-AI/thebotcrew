-- ============================================================
-- Test — 0067: la etapa del lead sólo sube (NULL < NI < I < A < C).
--
-- El piso se recalcula en cada turno con la ventana de 20 mensajes, así que un
-- turno tardío trae MENOS señales que uno anterior. Si el RPC dejara bajar la
-- etapa, un lead C volvería a I en cuanto los horarios salieran de la ventana.
-- `pnpm test:unit` mockea db/queries: esto sólo se prueba aquí.
--
--   psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
--     -v ON_ERROR_STOP=1 -f supabase/tests/0067_lead_stage.test.sql
--
-- Corre dentro de una transacción y hace ROLLBACK: no deja rastro.
-- ============================================================

\set ON_ERROR_STOP on
BEGIN;

DO $$
DECLARE
  v_client uuid;
  v_conv   uuid;
  v_ghl    text := 'test-0067-conv';
  v_res    jsonb;
  v_stage  text;
  v_src    text;
  v_int    text;
BEGIN
  SELECT id INTO v_client FROM public.clients LIMIT 1;
  IF v_client IS NULL THEN
    RAISE EXCEPTION 'no hay clients sembrados — corre `supabase db reset` primero';
  END IF;

  INSERT INTO public.conversations (client_id, channel, ghl_conversation_id, ghl_contact_id, status)
  VALUES (v_client, 'whatsapp', v_ghl, 'test-0067-contact', 'active')
  RETURNING id INTO v_conv;

  -- 1. nace sin etapa
  SELECT stage INTO v_stage FROM public.conversations WHERE id = v_conv;
  ASSERT v_stage IS NULL, 'una conversación nueva no debe traer etapa';

  -- 2. el primer piso se escribe
  v_res := public.app_set_conversation_stage(v_ghl, 'NI', 'rules');
  ASSERT (v_res->>'written')::boolean, 'el primer piso debió escribirse';
  ASSERT v_res->'from' = 'null'::jsonb, format('from debió ser null: %s', v_res);

  -- 3. subir escribe y reporta de dónde venía
  v_res := public.app_set_conversation_stage(v_ghl, 'A', 'llm');
  ASSERT (v_res->>'written')::boolean, 'subir a A debió escribirse';
  ASSERT v_res->>'from' = 'NI', format('from debió ser NI: %s', v_res);
  SELECT stage, stage_source INTO v_stage, v_src FROM public.conversations WHERE id = v_conv;
  ASSERT v_stage = 'A' AND v_src = 'llm', format('quedó %s/%s', v_stage, v_src);

  -- 4. bajar NO escribe (el turno tardío con menos señales)
  v_res := public.app_set_conversation_stage(v_ghl, 'I', 'rules');
  ASSERT NOT (v_res->>'written')::boolean, 'bajar de A a I no debe escribirse';
  SELECT stage, stage_source INTO v_stage, v_src FROM public.conversations WHERE id = v_conv;
  ASSERT v_stage = 'A' AND v_src = 'llm', format('bajó: %s/%s', v_stage, v_src);

  -- 5. la misma etapa tampoco escribe (sin evento repetido)
  v_res := public.app_set_conversation_stage(v_ghl, 'A', 'rules');
  ASSERT NOT (v_res->>'written')::boolean, 'la misma etapa no debe re-escribirse';

  -- 6. basura se ignora
  v_res := public.app_set_conversation_stage(v_ghl, 'HOT', 'rules');
  ASSERT NOT (v_res->>'written')::boolean, 'una etapa inválida no debe escribirse';
  v_res := public.app_set_conversation_stage(v_ghl, 'C', 'guess');
  ASSERT NOT (v_res->>'written')::boolean, 'una fuente inválida no debe escribirse';

  -- 7. conversación inexistente
  v_res := public.app_set_conversation_stage('no-such-conv', 'C', 'rules');
  ASSERT NOT (v_res->>'written')::boolean, 'una conversación inexistente no escribe';

  -- 8. interés: el último no-nulo gana, NULL no borra
  PERFORM public.app_set_conversation_interest(v_ghl, 'Botox');
  PERFORM public.app_set_conversation_interest(v_ghl, NULL);
  SELECT interest INTO v_int FROM public.conversations WHERE id = v_conv;
  ASSERT v_int = 'Botox', format('interest quedó %s', v_int);
  PERFORM public.app_set_conversation_interest(v_ghl, 'Láser');
  SELECT interest INTO v_int FROM public.conversations WHERE id = v_conv;
  ASSERT v_int = 'Láser', format('interest debió actualizarse: %s', v_int);

  -- 9. el evento nuevo pasa el CHECK
  INSERT INTO public.bot_events (client_id, conversation_id, event_type, metadata)
  VALUES (v_client, v_conv, 'stage_changed', '{"from":null,"to":"NI"}'::jsonb);

  RAISE NOTICE '0067 OK';
END $$;

ROLLBACK;
