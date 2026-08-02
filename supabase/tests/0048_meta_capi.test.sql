-- ============================================================
-- Test — 0048: Meta CAPI — cola durable de eventos de conversión.
--
-- La idempotencia del enqueue y el join de config viven en SQL; `pnpm test:unit`
-- mockea db/queries, así que esta es la mitad que de verdad garantiza que un
-- evento por conversación/kind se encola UNA vez y que el drain lee la config
-- viva del tenant (rotación de token sin re-encolar).
--
--   psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
--     -v ON_ERROR_STOP=1 -f supabase/tests/0048_meta_capi.test.sql
--
-- Corre dentro de una transacción y hace ROLLBACK: no deja rastro.
-- ============================================================

\set ON_ERROR_STOP on
BEGIN;

DO $$
DECLARE
  v_client    uuid;
  v_tenant    uuid;
  v_ghl       text := 'test-0048-conv';
  v_inserted  boolean;
  v_count     int;
  v_row       record;
  v_id        uuid;
  v_rls       boolean;
BEGIN
  -- Un tenant activo sembrado, con su tenant_config.
  SELECT t.client_id, t.id INTO v_client, v_tenant
  FROM public.tenants t
  JOIN public.tenant_config tc ON tc.tenant_id = t.id
  WHERE t.is_active
  LIMIT 1;
  IF v_client IS NULL THEN
    RAISE EXCEPTION 'no hay tenants sembrados — corre `supabase db reset` primero';
  END IF;

  UPDATE public.tenant_config
  SET meta_capi = '{"dataset_id":"ds1","page_id":"pg1","token_ref":"TEST"}'::jsonb
  WHERE tenant_id = v_tenant;

  -- ---------- 1. enqueue inserta y devuelve true ----------
  v_inserted := public.app_enqueue_capi_event(
    v_client, v_ghl, 'lead_started', 'LeadSubmitted', v_ghl || ':lead_started',
    '{"user_data":{"ctwa_clid":"Afj1","page_id":"pg1"}}'::jsonb
  );
  ASSERT v_inserted = true, 'el primer enqueue debió insertar (true)';

  -- ---------- 2. idempotente: el duplicado devuelve false y no duplica fila ----------
  v_inserted := public.app_enqueue_capi_event(
    v_client, v_ghl, 'lead_started', 'LeadSubmitted', v_ghl || ':lead_started',
    '{"user_data":{"ctwa_clid":"OTRO"}}'::jsonb
  );
  ASSERT v_inserted = false, 'el segundo enqueue debió devolver false';
  SELECT count(*) INTO v_count FROM public.capi_events WHERE event_id = v_ghl || ':lead_started';
  ASSERT v_count = 1, format('se esperaba 1 fila, hay %s', v_count);

  -- ---------- 3. el drain devuelve la fila con la config VIVA del tenant ----------
  SELECT * INTO v_row FROM public.app_load_pending_capi_events(20)
  WHERE event_id = v_ghl || ':lead_started';
  ASSERT v_row.id IS NOT NULL, 'el drain no encontró la fila pendiente';
  ASSERT v_row.meta_capi->>'token_ref' = 'TEST', 'el drain no trae la meta_capi del tenant';
  ASSERT v_row.kind = 'lead_started' AND v_row.event_name = 'LeadSubmitted',
    'kind/event_name no llegaron intactos';
  v_id := v_row.id;

  -- La config se lee fresca: una rotación de token_ref llega sin re-encolar.
  UPDATE public.tenant_config
  SET meta_capi = '{"dataset_id":"ds1","page_id":"pg1","token_ref":"ROTADO"}'::jsonb
  WHERE tenant_id = v_tenant;
  SELECT * INTO v_row FROM public.app_load_pending_capi_events(20)
  WHERE event_id = v_ghl || ':lead_started';
  ASSERT v_row.meta_capi->>'token_ref' = 'ROTADO', 'el drain no leyó la config fresca';

  -- ---------- 4. mark 'pending' + error estaciona sin cambiar estado ----------
  PERFORM public.app_mark_capi_event(v_id, 'pending', 'missing_token_secret');
  SELECT status, last_error INTO v_row FROM public.capi_events WHERE id = v_id;
  ASSERT v_row.status = 'pending' AND v_row.last_error = 'missing_token_secret',
    'estacionar con diagnóstico no funcionó';

  -- ---------- 5. attempts y el tope del drain ----------
  PERFORM public.app_increment_capi_attempts(v_id);
  PERFORM public.app_increment_capi_attempts(v_id);
  PERFORM public.app_increment_capi_attempts(v_id);
  SELECT count(*) INTO v_count FROM public.app_load_pending_capi_events(20)
  WHERE event_id = v_ghl || ':lead_started';
  ASSERT v_count = 0, 'una fila con 3 intentos no debe volver a salir del drain';

  -- ---------- 6. sent estampa sent_at; failed no ----------
  PERFORM public.app_mark_capi_event(v_id, 'sent');
  SELECT status, sent_at INTO v_row FROM public.capi_events WHERE id = v_id;
  ASSERT v_row.status = 'sent' AND v_row.sent_at IS NOT NULL, 'sent no estampó sent_at';

  v_inserted := public.app_enqueue_capi_event(
    v_client, v_ghl, 'appointment_booked', 'QualifiedLead', v_ghl || ':appointment_booked',
    '{"user_data":{"ctwa_clid":"Afj1"}}'::jsonb
  );
  SELECT id INTO v_id FROM public.capi_events WHERE event_id = v_ghl || ':appointment_booked';
  PERFORM public.app_mark_capi_event(v_id, 'failed', 'graph 400: bad');
  SELECT status, sent_at, last_error INTO v_row FROM public.capi_events WHERE id = v_id;
  ASSERT v_row.status = 'failed' AND v_row.sent_at IS NULL AND v_row.last_error = 'graph 400: bad',
    'failed no quedó bien registrado';

  -- una fila sent/failed tampoco sale del drain
  SELECT count(*) INTO v_count FROM public.app_load_pending_capi_events(20)
  WHERE ghl_conversation_id = v_ghl;
  ASSERT v_count = 0, 'filas sent/failed salieron del drain';

  -- ---------- 7. kind fuera del enum truena (constraint) ----------
  BEGIN
    PERFORM public.app_enqueue_capi_event(
      v_client, v_ghl, 'kind_inventado', 'Purchase', v_ghl || ':x', '{}'::jsonb
    );
    RAISE EXCEPTION 'un kind inválido debió fallar la constraint';
  EXCEPTION WHEN check_violation THEN
    NULL; -- esperado
  END;

  -- ---------- 8. RLS encendido, cero policies (regla 0032) ----------
  SELECT relrowsecurity INTO v_rls FROM pg_class WHERE oid = 'public.capi_events'::regclass;
  ASSERT v_rls = true, 'capi_events debe tener RLS habilitado';
  SELECT count(*) INTO v_count FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'capi_events';
  ASSERT v_count = 0, 'capi_events no debe tener policies (deny-by-default)';

  -- Las RPC no son ejecutables por anon/authenticated.
  ASSERT NOT has_function_privilege('anon', 'public.app_enqueue_capi_event(uuid,text,text,text,text,jsonb)', 'EXECUTE'),
    'anon puede ejecutar app_enqueue_capi_event';
  ASSERT NOT has_function_privilege('authenticated', 'public.app_load_pending_capi_events(int)', 'EXECUTE'),
    'authenticated puede ejecutar app_load_pending_capi_events';

  -- ---------- 9. bot_events acepta los tipos nuevos (y uno viejo sigue vivo) ----------
  INSERT INTO public.bot_events (client_id, event_type, metadata)
  VALUES (v_client, 'capi_event_sent', '{"kind":"lead_started"}'::jsonb),
         (v_client, 'capi_error', '{"stage":"missing_token_secret"}'::jsonb),
         (v_client, 'attachment_received', '{}'::jsonb);

  -- ---------- 10. columnas de atribución en conversations ----------
  INSERT INTO public.conversations (client_id, channel, ghl_conversation_id, ghl_contact_id, status, ctwa_clid, attribution)
  VALUES (v_client, 'whatsapp', v_ghl, 'test-0048-contact', 'active', 'Afj1',
          '{"sessionSource":"Paid Social","adId":"120"}'::jsonb);
  SELECT count(*) INTO v_count FROM public.conversations
  WHERE ghl_conversation_id = v_ghl AND ctwa_clid = 'Afj1' AND attribution->>'adId' = '120';
  ASSERT v_count = 1, 'ctwa_clid/attribution no se guardaron en conversations';

  RAISE NOTICE 'OK — 0048: cola CAPI idempotente, drain con config viva, RLS cerrado (10 casos)';
END $$;

ROLLBACK;
