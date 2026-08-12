-- ============================================================
-- Test — 0051: la fecha de baja de marketing se escribe UNA vez y no se borra.
--
-- El candado que importa vive en SQL: el `IS NULL` del RPC es lo único que hace
-- que la fecha sea write-once, y `pnpm test:unit` mockea db/queries — así que los
-- tests de TS sólo prueban que el handler llama al RPC, nunca que el RPC respeta
-- la fecha original. Eso se prueba aquí.
--
--   psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
--     -v ON_ERROR_STOP=1 -f supabase/tests/0051_marketing_opt_out.test.sql
--
-- Corre dentro de una transacción y hace ROLLBACK: no deja rastro.
-- ============================================================

\set ON_ERROR_STOP on
BEGIN;

DO $$
DECLARE
  v_client   uuid;
  v_conv     uuid;
  v_other    uuid;
  v_ghl      text := 'test-0051-conv';
  v_ghl2     text := 'test-0051-conv-2';
  v_contact  text := 'test-0051-contact';
  v_first    timestamptz;
  v_after    timestamptz;
  v_status   text;
  v_count    int;
BEGIN
  SELECT id INTO v_client FROM public.clients LIMIT 1;
  IF v_client IS NULL THEN
    RAISE EXCEPTION 'no hay clients sembrados — corre `supabase db reset` primero';
  END IF;

  INSERT INTO public.conversations (client_id, channel, ghl_conversation_id, ghl_contact_id, status)
  VALUES (v_client, 'whatsapp', v_ghl, v_contact, 'active')
  RETURNING id INTO v_conv;

  -- ---------- 1. nace NULL ----------
  SELECT marketing_opted_out_at INTO v_first FROM public.conversations WHERE id = v_conv;
  ASSERT v_first IS NULL, 'una conversación nueva no debe traer fecha de baja';

  -- ---------- 2. la primera vez sí estampa ----------
  v_count := public.app_set_marketing_opt_out_by_contact(v_contact);
  ASSERT v_count = 1, format('se esperaba 1 fila estampada, hubo %s', v_count);

  SELECT marketing_opted_out_at INTO v_first FROM public.conversations WHERE id = v_conv;
  ASSERT v_first IS NOT NULL, 'no se escribió la fecha';

  -- ---------- 3. la segunda no toca nada (esto ES el write-once) ----------
  -- GHL manda la lista COMPLETA de tags en cualquier cambio de tag, así que este
  -- webhook se repite todo el tiempo. Si el RPC re-estampara, la fecha original —
  -- lo único que esta columna aporta — se perdería en el primer tag no relacionado.
  PERFORM pg_sleep(0.01);
  v_count := public.app_set_marketing_opt_out_by_contact(v_contact);
  ASSERT v_count = 0, format('la segunda llamada cambió %s filas', v_count);

  SELECT marketing_opted_out_at INTO v_after FROM public.conversations WHERE id = v_conv;
  ASSERT v_after = v_first, format('la fecha original se movió: %s → %s', v_first, v_after);

  -- ---------- 4. es por CONTACTO: alcanza todas sus conversaciones ----------
  -- 'instagram' y no 'facebook' a propósito: la constraint de canal difiere entre
  -- local y prod (ver el hallazgo de drift de migraciones con sufijo de letra).
  INSERT INTO public.conversations (client_id, channel, ghl_conversation_id, ghl_contact_id, status)
  VALUES (v_client, 'instagram', v_ghl2, v_contact, 'active')
  RETURNING id INTO v_other;

  -- La conversación vieja ya tiene fecha, así que sólo debe estamparse la nueva:
  -- una conversación creada DESPUÉS de la baja nace NULL (ver el caveat de alcance
  -- en la migración) y se llena en el siguiente webhook, sin pisar a la anterior.
  v_count := public.app_set_marketing_opt_out_by_contact(v_contact);
  ASSERT v_count = 1, format('se esperaba estampar sólo la conversación nueva, hubo %s', v_count);

  SELECT marketing_opted_out_at INTO v_after FROM public.conversations WHERE id = v_conv;
  ASSERT v_after = v_first, 'estampar la conversación nueva movió la fecha de la vieja';

  SELECT marketing_opted_out_at INTO v_after FROM public.conversations WHERE id = v_other;
  ASSERT v_after IS NOT NULL, 'la segunda conversación del contacto quedó sin fecha';

  -- ---------- 5. no toca el estado de la conversación ----------
  -- La baja de marketing no es la baja del bot (0045). El bot sigue contestando.
  SELECT status INTO v_status FROM public.conversations WHERE id = v_conv;
  ASSERT v_status = 'active', format('la baja de marketing movió el estado: %s', v_status);
  ASSERT public.app_is_bot_suppressed(v_ghl) = false,
    'la baja de marketing silenció al bot — es consentimiento de campañas, no de la conversación';

  -- ---------- 6. un contacto desconocido no explota ----------
  -- Éste es el caso real de un contacto de pura lista de marketing que nunca le
  -- escribió al bot: no hay filas que estampar y su baja no se registra en ningún
  -- lado. Es el límite de vivir en `conversations` (ver la migración).
  ASSERT public.app_set_marketing_opt_out_by_contact('no-existe-0051') = 0,
    'un contacto inexistente debió devolver 0';

  RAISE NOTICE 'OK — 0051: la fecha de baja de marketing es write-once y no toca el estado (6 casos)';
END $$;

ROLLBACK;
