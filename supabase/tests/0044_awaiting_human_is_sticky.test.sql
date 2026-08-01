-- ============================================================
-- Test — 0044: `awaiting_human` no se puede pisar con un estado reactivable.
--
-- El candado vive en SQL, así que `pnpm test:unit` (que mockea db/queries) no
-- puede tocarlo: los tests de TS solo cubren qué hace el Worker con el boolean.
-- Esto cubre la otra mitad, la que de verdad protege a la lead.
--
--   psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
--     -v ON_ERROR_STOP=1 -f supabase/tests/0044_awaiting_human_is_sticky.test.sql
--
-- Corre dentro de una transacción y hace ROLLBACK: no deja rastro, se puede
-- repetir contra la DB local sin resetear.
-- ============================================================

\set ON_ERROR_STOP on
BEGIN;

DO $$
DECLARE
  v_client uuid;
  v_conv   uuid;
  v_ghl    text := 'test-0044-conv';
  v_ok     boolean;
  v_status text;
  v_events int;
BEGIN
  SELECT id INTO v_client FROM public.clients LIMIT 1;
  IF v_client IS NULL THEN
    RAISE EXCEPTION 'no hay clients sembrados — corre `supabase db reset` primero';
  END IF;

  INSERT INTO public.conversations (client_id, channel, ghl_conversation_id, ghl_contact_id, status)
  VALUES (v_client, 'whatsapp', v_ghl, 'test-0044-contact', 'awaiting_human')
  RETURNING id INTO v_conv;

  -- ---------- 1. standby sobre awaiting_human: rechazado ----------
  v_ok := public.app_update_conversation_status(v_ghl, 'standby');
  ASSERT v_ok = false, 'standby sobre awaiting_human debió devolver false';

  SELECT status INTO v_status FROM public.conversations WHERE id = v_conv;
  ASSERT v_status = 'awaiting_human', format('el estado se movió a %s', v_status);

  SELECT count(*) INTO v_events FROM public.bot_events
  WHERE conversation_id = v_conv AND event_type = 'status_change_blocked';
  ASSERT v_events = 1, format('se esperaba 1 evento status_change_blocked, hay %s', v_events);

  -- ---------- 2. completed sobre awaiting_human: rechazado ----------
  v_ok := public.app_update_conversation_status(v_ghl, 'completed');
  ASSERT v_ok = false, 'completed sobre awaiting_human debió devolver false';

  SELECT status INTO v_status FROM public.conversations WHERE id = v_conv;
  ASSERT v_status = 'awaiting_human', format('completed pisó el estado: %s', v_status);

  -- ---------- 3. la consecuencia real: la lead no es reactivable ----------
  -- Es el escenario completo: la lead vuelve a escribir después del intento de
  -- pisar el estado. Antes de 0044 aquí ya estaría en `active` y con cadencia.
  PERFORM public.app_reactivate_conversation(v_ghl);
  SELECT status INTO v_status FROM public.conversations WHERE id = v_conv;
  ASSERT v_status = 'awaiting_human', format('un mensaje entrante la reactivó a %s', v_status);

  -- ---------- 4. y por lo tanto no se le puede agendar un nudge ----------
  ASSERT public.app_schedule_follow_up(v_conv, 1, now() + interval '1 hour', 'cadence') IS NULL,
    'se agendó un follow-up a una lead en awaiting_human';

  -- ---------- 5. las señales más fuertes SÍ pasan ----------
  v_ok := public.app_update_conversation_status(v_ghl, 'opted_out');
  ASSERT v_ok = true, 'opted_out debió aplicar (la lead revocó el permiso: gana)';
  SELECT status INTO v_status FROM public.conversations WHERE id = v_conv;
  ASSERT v_status = 'opted_out', format('opted_out no aplicó: %s', v_status);

  UPDATE public.conversations SET status = 'awaiting_human' WHERE id = v_conv;
  v_ok := public.app_update_conversation_status(v_ghl, 'handed_off');
  ASSERT v_ok = true, 'handed_off debió aplicar (silencia al bot: gana)';
  SELECT status INTO v_status FROM public.conversations WHERE id = v_conv;
  ASSERT v_status = 'handed_off', format('handed_off no aplicó: %s', v_status);

  -- ---------- 6. el camino normal sigue intacto ----------
  UPDATE public.conversations SET status = 'active' WHERE id = v_conv;
  v_ok := public.app_update_conversation_status(v_ghl, 'standby');
  ASSERT v_ok = true, 'standby sobre active debió aplicar';
  SELECT status INTO v_status FROM public.conversations WHERE id = v_conv;
  ASSERT v_status = 'standby', format('standby sobre active no aplicó: %s', v_status);

  -- ...y desde standby la lead sí se reactiva sola, como siempre.
  PERFORM public.app_reactivate_conversation(v_ghl);
  SELECT status INTO v_status FROM public.conversations WHERE id = v_conv;
  ASSERT v_status = 'active', format('standby dejó de ser reactivable: %s', v_status);

  -- ---------- 7. conversación inexistente: false, sin explotar ----------
  ASSERT public.app_update_conversation_status('no-existe-0044', 'standby') = false,
    'una conversación inexistente debió devolver false';

  RAISE NOTICE 'OK — 0044: awaiting_human es sticky (7 casos)';
END $$;

ROLLBACK;
