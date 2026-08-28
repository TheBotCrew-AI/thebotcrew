-- ============================================================
-- Test — 0057: la zona del lead — el teléfono sólo rellena, el lead siempre gana.
--
-- La precedencia vive en el RPC, no en el Worker: el webhook adivina la zona por
-- LADA en CADA inbound y la tool la escribe cuando el lead dice dónde está. Si
-- la adivinanza pudiera pisar la palabra del lead, la corrección duraría un
-- mensaje. `pnpm test:unit` mockea db/queries, así que eso sólo se prueba aquí.
--
--   psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
--     -v ON_ERROR_STOP=1 -f supabase/tests/0057_lead_timezone.test.sql
--
-- Corre dentro de una transacción y hace ROLLBACK: no deja rastro.
-- ============================================================

\set ON_ERROR_STOP on
BEGIN;

DO $$
DECLARE
  v_client  uuid;
  v_conv    uuid;
  v_ghl     text := 'test-0057-conv';
  v_tz      text;
  v_src     text;
  v_ok      boolean;
BEGIN
  SELECT id INTO v_client FROM public.clients LIMIT 1;
  IF v_client IS NULL THEN
    RAISE EXCEPTION 'no hay clients sembrados — corre `supabase db reset` primero';
  END IF;

  INSERT INTO public.conversations (client_id, channel, ghl_conversation_id, ghl_contact_id, status)
  VALUES (v_client, 'whatsapp', v_ghl, 'test-0057-contact', 'active')
  RETURNING id INTO v_conv;

  -- ---------- 1. nace vacía ----------
  SELECT lead_timezone, lead_timezone_source INTO v_tz, v_src FROM public.conversations WHERE id = v_conv;
  ASSERT v_tz IS NULL AND v_src IS NULL, 'una conversación nueva no debe traer zona';

  -- ---------- 2. la adivinanza por teléfono rellena el hueco ----------
  v_ok := public.app_set_lead_timezone(v_ghl, 'America/Mexico_City', 'phone');
  ASSERT v_ok, 'la primera adivinanza por teléfono debió escribirse';
  SELECT lead_timezone, lead_timezone_source INTO v_tz, v_src FROM public.conversations WHERE id = v_conv;
  ASSERT v_tz = 'America/Mexico_City' AND v_src = 'phone', format('quedó %s/%s', v_tz, v_src);

  -- ---------- 3. una segunda adivinanza NO pisa (el webhook la repite en cada inbound) ----------
  v_ok := public.app_set_lead_timezone(v_ghl, 'America/Tijuana', 'phone');
  ASSERT NOT v_ok, 'una adivinanza no debe pisar una zona ya escrita';
  SELECT lead_timezone INTO v_tz FROM public.conversations WHERE id = v_conv;
  ASSERT v_tz = 'America/Mexico_City', format('la adivinanza pisó la zona: %s', v_tz);

  -- ---------- 4. la palabra del lead pisa la adivinanza ----------
  v_ok := public.app_set_lead_timezone(v_ghl, 'America/Cancun', 'lead');
  ASSERT v_ok, 'la palabra del lead debió escribirse';
  SELECT lead_timezone, lead_timezone_source INTO v_tz, v_src FROM public.conversations WHERE id = v_conv;
  ASSERT v_tz = 'America/Cancun' AND v_src = 'lead', format('quedó %s/%s', v_tz, v_src);

  -- ---------- 5. …y una adivinanza posterior NO la pisa (esto ES la corrección durable) ----------
  v_ok := public.app_set_lead_timezone(v_ghl, 'America/Mexico_City', 'phone');
  ASSERT NOT v_ok, 'el teléfono pisó lo que dijo el lead';
  SELECT lead_timezone, lead_timezone_source INTO v_tz, v_src FROM public.conversations WHERE id = v_conv;
  ASSERT v_tz = 'America/Cancun' AND v_src = 'lead', format('la corrección del lead se perdió: %s/%s', v_tz, v_src);

  -- ---------- 6. el lead se corrige a sí mismo ----------
  v_ok := public.app_set_lead_timezone(v_ghl, 'America/Hermosillo', 'lead');
  ASSERT v_ok, 'el lead debe poder corregirse';
  SELECT lead_timezone INTO v_tz FROM public.conversations WHERE id = v_conv;
  ASSERT v_tz = 'America/Hermosillo', format('la segunda corrección no entró: %s', v_tz);

  -- ---------- 7. basura no entra ----------
  ASSERT NOT public.app_set_lead_timezone(v_ghl, 'America/Tijuana', 'guess'), 'un source inválido debe rechazarse';
  ASSERT NOT public.app_set_lead_timezone(v_ghl, NULL, 'lead'), 'una zona NULL debe rechazarse';
  ASSERT NOT public.app_set_lead_timezone('no-existe-0057', 'America/Tijuana', 'lead'), 'una conversación inexistente devuelve false';
  SELECT lead_timezone INTO v_tz FROM public.conversations WHERE id = v_conv;
  ASSERT v_tz = 'America/Hermosillo', format('una llamada rechazada tocó la zona: %s', v_tz);

  -- ---------- 8. el tenant nace con el flag apagado ----------
  ASSERT (SELECT bool_and(NOT lead_timezone_enabled) FROM public.tenant_config),
    'lead_timezone_enabled debe nacer false: un negocio presencial no quiere horas corridas';

  RAISE NOTICE '0057 OK';
END $$;

ROLLBACK;
