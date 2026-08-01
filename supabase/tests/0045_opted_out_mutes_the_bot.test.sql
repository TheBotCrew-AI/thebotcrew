-- ============================================================
-- Test — 0045: `opted_out` calla al bot, y quitar el tag es la única vuelta atrás.
--
-- Igual que 0044: el candado vive en SQL y `pnpm test:unit` mockea db/queries,
-- así que los tests de TS solo cubren qué hace el Worker con el boolean. Esta es
-- la mitad que de verdad protege a alguien que pidió que dejáramos de escribirle.
--
--   psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
--     -v ON_ERROR_STOP=1 -f supabase/tests/0045_opted_out_mutes_the_bot.test.sql
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
  v_ghl      text := 'test-0045-conv';
  v_ghl2     text := 'test-0045-conv-2';
  v_contact  text := 'test-0045-contact';
  v_status   text;
  v_count    int;
  v_events   int;
BEGIN
  SELECT id INTO v_client FROM public.clients LIMIT 1;
  IF v_client IS NULL THEN
    RAISE EXCEPTION 'no hay clients sembrados — corre `supabase db reset` primero';
  END IF;

  INSERT INTO public.conversations (client_id, channel, ghl_conversation_id, ghl_contact_id, status)
  VALUES (v_client, 'whatsapp', v_ghl, v_contact, 'active')
  RETURNING id INTO v_conv;

  -- ---------- 1. active: el bot habla ----------
  ASSERT public.app_is_bot_suppressed(v_ghl) = false,
    'una conversación activa no debe estar silenciada';

  -- ---------- 2. opted_out: el bot se calla (esto es 0045) ----------
  -- Antes de esta migración esto devolvía false y el bot le seguía contestando a
  -- alguien que ya había dicho "no me escribas".
  UPDATE public.conversations SET status = 'opted_out' WHERE id = v_conv;
  ASSERT public.app_is_bot_suppressed(v_ghl) = true,
    'opted_out debe silenciar al bot';

  -- ---------- 3. sigue sin ser reactivable por un mensaje entrante ----------
  -- El consentimiento no se revoca solo porque la lead vuelva a escribir.
  PERFORM public.app_reactivate_conversation(v_ghl);
  SELECT status INTO v_status FROM public.conversations WHERE id = v_conv;
  ASSERT v_status = 'opted_out', format('un inbound reactivó a la lead: %s', v_status);

  -- ---------- 4. y no se le puede agendar un nudge ----------
  ASSERT public.app_schedule_follow_up(v_conv, 1, now() + interval '1 hour', 'cadence') IS NULL,
    'se agendó un follow-up a una lead en opted_out';
  ASSERT public.app_schedule_follow_up(v_conv, 1, now() + interval '1 hour', 'demo') IS NULL,
    'se agendó un recordatorio de demo a una lead en opted_out';

  -- ---------- 5. quitar el tag es la vuelta atrás ----------
  v_count := public.app_clear_opted_out_by_contact(v_contact);
  ASSERT v_count = 1, format('se esperaba 1 conversación liberada, hubo %s', v_count);

  SELECT status INTO v_status FROM public.conversations WHERE id = v_conv;
  ASSERT v_status = 'active', format('la lead no volvió a active: %s', v_status);
  ASSERT public.app_is_bot_suppressed(v_ghl) = false,
    'tras limpiar el opt-out el bot debe poder hablar otra vez';

  -- ---------- 6. deshacer un "stop" queda auditado, siempre ----------
  SELECT count(*) INTO v_events FROM public.bot_events
  WHERE conversation_id = v_conv
    AND event_type = 'status_changed'
    AND metadata->>'via' = 'opted_out_tag';
  ASSERT v_events = 1, format('se esperaba 1 evento de auditoría, hay %s', v_events);

  -- ---------- 7. es idempotente: sin nada que deshacer, no toca nada ----------
  -- Esto es lo que impide que el tag que escribe el propio bot haga un loop.
  v_count := public.app_clear_opted_out_by_contact(v_contact);
  ASSERT v_count = 0, format('limpiar dos veces cambió %s filas', v_count);

  -- ---------- 8. nunca pisa handed_off (señal más fuerte) ----------
  UPDATE public.conversations SET status = 'handed_off' WHERE id = v_conv;
  v_count := public.app_clear_opted_out_by_contact(v_contact);
  ASSERT v_count = 0, 'clear_opted_out pisó un handed_off';
  SELECT status INTO v_status FROM public.conversations WHERE id = v_conv;
  ASSERT v_status = 'handed_off', format('handed_off se perdió: %s', v_status);
  ASSERT public.app_is_bot_suppressed(v_ghl) = true,
    'handed_off debe seguir silenciando';

  -- ---------- 9. es por CONTACTO: alcanza a todas sus conversaciones ----------
  -- 'instagram' y no 'facebook' a propósito: la constraint de canal difiere entre
  -- local y prod (ver el hallazgo de drift de migraciones con sufijo de letra).
  INSERT INTO public.conversations (client_id, channel, ghl_conversation_id, ghl_contact_id, status)
  VALUES (v_client, 'instagram', v_ghl2, v_contact, 'opted_out')
  RETURNING id INTO v_other;

  UPDATE public.conversations SET status = 'opted_out' WHERE id = v_conv;
  v_count := public.app_clear_opted_out_by_contact(v_contact);
  ASSERT v_count = 2, format('se esperaban 2 conversaciones del contacto, hubo %s', v_count);

  -- ---------- 10. un contacto desconocido no explota ----------
  ASSERT public.app_clear_opted_out_by_contact('no-existe-0045') = 0,
    'un contacto inexistente debió devolver 0';

  -- ---------- 11. el timer del humano sigue intacto ----------
  UPDATE public.conversations
    SET status = 'active', human_active_until = now() + interval '5 minutes'
    WHERE id = v_conv;
  ASSERT public.app_is_bot_suppressed(v_ghl) = true,
    'el timer del humano dejó de silenciar';

  RAISE NOTICE 'OK — 0045: opted_out calla al bot y el tag es la vuelta atrás (11 casos)';
END $$;

ROLLBACK;
