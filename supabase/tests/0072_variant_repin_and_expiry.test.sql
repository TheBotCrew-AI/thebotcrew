-- ============================================================
-- Test — 0072: re-pin por keyword + expiración del pin por silencio.
--
-- Las dos reglas viven en los RPCs y `pnpm test:unit` mockea db/queries: esto es la
-- única prueba de que el pin cambia (o no) cuando debe.
--
--   psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
--     -v ON_ERROR_STOP=1 -f supabase/tests/0072_variant_repin_and_expiry.test.sql
--
-- Corre dentro de una transacción y hace ROLLBACK: no deja rastro.
-- ============================================================

\set ON_ERROR_STOP on
BEGIN;

DO $$
DECLARE
  v_client uuid;
  v_conv   uuid;
  v_ghl    text := 'test-0072-conv';
  v_old    uuid;
  v_new    uuid;
  v_res    text;
BEGIN
  SELECT id INTO v_client FROM public.clients LIMIT 1;
  IF v_client IS NULL THEN
    RAISE EXCEPTION 'no hay clients sembrados — corre `supabase db reset` primero';
  END IF;

  INSERT INTO public.conversations (client_id, channel, ghl_conversation_id, ghl_contact_id, status, reactivation_round)
  VALUES (v_client, 'whatsapp', v_ghl, 'test-0072-contact', 'standby', 2)
  RETURNING id INTO v_conv;

  -- ── re-pin ──
  -- 1. primer toque: pinea
  ASSERT public.app_set_prompt_variant(v_ghl, 'a02') = true, 'el primer toque debió pinear';
  ASSERT (SELECT prompt_variant FROM public.conversations WHERE id = v_conv) = 'a02';

  -- 2. sticky: otro keyword sin force no cambia nada
  ASSERT public.app_set_prompt_variant(v_ghl, 'lp5') = false, 'sin force debe ser no-op';
  ASSERT (SELECT prompt_variant FROM public.conversations WHERE id = v_conv) = 'a02';

  -- 3. force: reemplaza y reinicia la ronda
  ASSERT public.app_set_prompt_variant(v_ghl, 'r-botox', true) = true, 'con force debió re-pinear';
  ASSERT (SELECT prompt_variant FROM public.conversations WHERE id = v_conv) = 'r-botox';
  ASSERT (SELECT reactivation_round FROM public.conversations WHERE id = v_conv) = 0, 'el re-pin reinicia la ronda';

  -- 4. force sobre la misma variante: no-op (no reinicia la ronda otra vez)
  UPDATE public.conversations SET reactivation_round = 1 WHERE id = v_conv;
  ASSERT public.app_set_prompt_variant(v_ghl, 'r-botox', true) = false, 'force sobre la misma variante debe ser no-op';
  ASSERT (SELECT reactivation_round FROM public.conversations WHERE id = v_conv) = 1, 'no debió tocar la ronda';

  -- 5. force sobre una conversación sin pin: pinea sin tocar la ronda
  UPDATE public.conversations SET prompt_variant = NULL, reactivation_round = 1 WHERE id = v_conv;
  ASSERT public.app_set_prompt_variant(v_ghl, 'r-botox', true) = true;
  ASSERT (SELECT reactivation_round FROM public.conversations WHERE id = v_conv) = 1, 'un primer toque forzado conserva la ronda';

  -- ── expiración ──
  -- el inbound viejo (hace 40 días) y el de hoy
  INSERT INTO public.messages (conversation_id, direction, sender_type, content, sent_at)
  VALUES (v_conv, 'inbound', 'lead', 'hola hace 40 días', now() - interval '40 days') RETURNING id INTO v_old;
  INSERT INTO public.messages (conversation_id, direction, sender_type, content, sent_at)
  VALUES (v_conv, 'outbound', 'bot', 'nudge de hace 3 días', now() - interval '3 days');
  INSERT INTO public.messages (conversation_id, direction, sender_type, content, sent_at)
  VALUES (v_conv, 'inbound', 'lead', 'hola hoy', now()) RETURNING id INTO v_new;

  -- 6. sin TTL: nunca expira
  ASSERT public.app_expire_prompt_variant(v_conv, v_new, NULL) IS NULL, 'TTL NULL = nunca';
  ASSERT (SELECT prompt_variant FROM public.conversations WHERE id = v_conv) = 'r-botox';

  -- 7. TTL 60: el último inbound anterior tiene 40 días → sigue vivo
  ASSERT public.app_expire_prompt_variant(v_conv, v_new, 60) IS NULL, '40 días < 60: no expira';

  -- 8. TTL 30: expira, y el nudge del bot de hace 3 días NO lo mantuvo vivo
  v_res := public.app_expire_prompt_variant(v_conv, v_new, 30);
  ASSERT v_res = 'r-botox', format('debió devolver la variante expirada: %s', v_res);
  ASSERT (SELECT prompt_variant FROM public.conversations WHERE id = v_conv) IS NULL, 'debió limpiar el pin';

  -- 9. ya sin pin: no-op
  ASSERT public.app_expire_prompt_variant(v_conv, v_new, 30) IS NULL;

  -- 10. un hilo cuyo ÚNICO inbound es el de hoy no expira (no hay silencio que medir)
  UPDATE public.conversations SET prompt_variant = 'a02' WHERE id = v_conv;
  DELETE FROM public.messages WHERE id = v_old;
  ASSERT public.app_expire_prompt_variant(v_conv, v_new, 30) IS NULL, 'sin inbound previo no hay silencio';
  ASSERT (SELECT prompt_variant FROM public.conversations WHERE id = v_conv) = 'a02';

  -- 11. el sender_type nuevo entra
  INSERT INTO public.messages (conversation_id, direction, sender_type, content, sent_at)
  VALUES (v_conv, 'outbound', 'campaign', 'plantilla', now());

  RAISE NOTICE '0072 OK';
END $$;

ROLLBACK;
