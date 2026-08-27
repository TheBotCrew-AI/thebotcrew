-- ============================================================
-- Test — 0056: la llave de matching de CAPI es una por canal, y el
-- ctwa_clid sigue vivo (expand/contract).
--
--   psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
--     -v ON_ERROR_STOP=1 -f supabase/tests/0056_capi_messaging_channels.test.sql
--
-- Corre dentro de una transacción y hace ROLLBACK: no deja rastro.
-- ============================================================

\set ON_ERROR_STOP on
BEGIN;

DO $$
DECLARE
  v_client uuid;
  v_count  int;
  v_row    record;
BEGIN
  SELECT t.client_id INTO v_client FROM public.tenants t WHERE t.is_active LIMIT 1;
  IF v_client IS NULL THEN
    RAISE EXCEPTION 'no hay tenants sembrados — corre `supabase db reset` primero';
  END IF;

  -- ---------- 1. un lead de Facebook guarda su PSID en capi_match_key, sin ctwa_clid ----------
  INSERT INTO public.conversations (client_id, channel, ghl_conversation_id, ghl_contact_id, status, capi_match_key, attribution)
  VALUES (v_client, 'facebook', 'test-0056-fb', 'test-0056-fb-contact', 'active', '36250000000000034',
          '{"sessionSource":"Paid Social","medium":"facebook","pSid":"36250000000000034","adId":"5251"}'::jsonb);
  SELECT capi_match_key, ctwa_clid INTO v_row FROM public.conversations WHERE ghl_conversation_id = 'test-0056-fb';
  ASSERT v_row.capi_match_key = '36250000000000034' AND v_row.ctwa_clid IS NULL,
    'el PSID de Facebook no quedó en capi_match_key (o ensució ctwa_clid)';

  -- ---------- 2. un lead de Instagram (orgánico: sin adId) también tiene llave ----------
  INSERT INTO public.conversations (client_id, channel, ghl_conversation_id, ghl_contact_id, status, capi_match_key, attribution)
  VALUES (v_client, 'instagram', 'test-0056-ig', 'test-0056-ig-contact', 'active', '1383000000000020',
          '{"sessionSource":"Social media","medium":"instagram","igSid":"1383000000000020","adId":null}'::jsonb);
  SELECT count(*) INTO v_count FROM public.conversations
  WHERE ghl_conversation_id = 'test-0056-ig' AND capi_match_key = '1383000000000020';
  ASSERT v_count = 1, 'el IGSID de Instagram no se guardó';

  -- ---------- 3. WhatsApp se escribe DOBLE durante el contract: ctwa_clid y capi_match_key iguales ----------
  INSERT INTO public.conversations (client_id, channel, ghl_conversation_id, ghl_contact_id, status, ctwa_clid, capi_match_key)
  VALUES (v_client, 'whatsapp', 'test-0056-wa', 'test-0056-wa-contact', 'active', 'AfjWA', 'AfjWA');
  SELECT ctwa_clid, capi_match_key INTO v_row FROM public.conversations WHERE ghl_conversation_id = 'test-0056-wa';
  ASSERT v_row.ctwa_clid = 'AfjWA' AND v_row.capi_match_key = 'AfjWA', 'WhatsApp debe llevar las dos columnas iguales';

  -- ---------- 4. la columna es opcional: una conversación sin atribución sigue naciendo NULL ----------
  INSERT INTO public.conversations (client_id, channel, ghl_conversation_id, ghl_contact_id, status)
  VALUES (v_client, 'whatsapp', 'test-0056-organic', 'test-0056-organic-contact', 'active');
  SELECT count(*) INTO v_count FROM public.conversations
  WHERE ghl_conversation_id = 'test-0056-organic' AND capi_match_key IS NULL AND ctwa_clid IS NULL;
  ASSERT v_count = 1, 'una conversación orgánica no debe tener llave';

  -- ---------- 5. el payload de la cola lleva el canal adentro; la RPC de 0048 no cambió ----------
  ASSERT public.app_enqueue_capi_event(
    v_client, 'test-0056-fb', 'lead_started', 'LeadSubmitted', 'test-0056-fb:lead_started',
    '{"messaging_channel":"messenger","user_data":{"page_id":"pg1","page_scoped_user_id":"36250000000000034"}}'::jsonb
  ) = true, 'el enqueue con canal en el payload debió insertar';
  SELECT payload->>'messaging_channel' AS ch INTO v_row FROM public.capi_events WHERE event_id = 'test-0056-fb:lead_started';
  ASSERT v_row.ch = 'messenger', 'messaging_channel no viajó intacto en el payload';

  RAISE NOTICE 'OK — 0056: capi_match_key por canal, ctwa_clid dual-write, canal en el payload (5 casos)';
END $$;

ROLLBACK;
