-- ============================================================
-- Test — 0073: segment tags / no-promos.
--
--   1. `segment_tags` nace false y los catálogos NULL: ningún tenant empieza a
--      etiquetar zonas por aplicar la migración.
--   2. `conversations.no_promos` nace false y `app_set_no_promos_by_contact` es un
--      switch idempotente en los dos sentidos (devuelve 0 en el webhook repetido).
--   3. Los eventos nuevos pasan el CHECK de bot_events; uno inventado sigue rechazado.
--
--   psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
--     -v ON_ERROR_STOP=1 -f supabase/tests/0073_segment_tags.test.sql
--
-- Corre dentro de una transacción y hace ROLLBACK: no deja rastro.
-- ============================================================

\set ON_ERROR_STOP on
BEGIN;

DO $$
DECLARE
  v_client uuid;
  v_n int;
  v_evt text;
BEGIN
  SELECT id INTO v_client FROM public.clients LIMIT 1;
  IF v_client IS NULL THEN
    RAISE EXCEPTION 'no hay clients sembrados — corre `supabase db reset` primero';
  END IF;

  -- ---------- 1. flags y catálogos nacen apagados ----------
  ASSERT (SELECT bool_and(NOT segment_tags) FROM public.tenant_config),
    'segment_tags debe nacer false';

  -- ---------- 2. no_promos: switch por contacto, idempotente ----------
  INSERT INTO public.conversations (client_id, ghl_conversation_id, ghl_contact_id, channel, status)
  VALUES (v_client, 'conv-np-1', 'contact-np', 'whatsapp', 'active'),
         (v_client, 'conv-np-2', 'contact-np', 'instagram', 'standby');

  ASSERT (SELECT bool_and(NOT no_promos) FROM public.conversations WHERE ghl_contact_id = 'contact-np'),
    'no_promos debe nacer false';

  v_n := public.app_set_no_promos_by_contact('contact-np', true);
  ASSERT v_n = 2, format('prender debió tocar 2 filas, tocó %s', v_n);
  v_n := public.app_set_no_promos_by_contact('contact-np', true);
  ASSERT v_n = 0, format('el webhook repetido debió tocar 0 filas, tocó %s', v_n);
  ASSERT (SELECT bool_and(no_promos) FROM public.conversations WHERE ghl_contact_id = 'contact-np'),
    'las dos conversaciones del contacto deben quedar no_promos';

  v_n := public.app_set_no_promos_by_contact('contact-np', false);
  ASSERT v_n = 2, format('apagar debió tocar 2 filas, tocó %s', v_n);
  ASSERT (SELECT bool_and(NOT no_promos) FROM public.conversations WHERE ghl_contact_id = 'contact-np'),
    'quitar el tag debe apagar no_promos';

  v_n := public.app_set_no_promos_by_contact('contacto-que-no-existe', true);
  ASSERT v_n = 0, 'un contacto sin conversaciones devuelve 0';

  -- ---------- 3. eventos nuevos ----------
  FOREACH v_evt IN ARRAY ARRAY['zone_tagged', 'objection_tagged', 'segment_note_added', 'no_promos_on', 'no_promos_off'] LOOP
    INSERT INTO public.bot_events (client_id, event_type, metadata) VALUES (v_client, v_evt, '{}'::jsonb);
  END LOOP;

  BEGIN
    INSERT INTO public.bot_events (client_id, event_type, metadata)
    VALUES (v_client, 'not_a_real_event', '{}'::jsonb);
    RAISE EXCEPTION 'el CHECK de event_type dejó pasar un tipo inventado';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;

  RAISE NOTICE '0073 ok';
END $$;

ROLLBACK;
