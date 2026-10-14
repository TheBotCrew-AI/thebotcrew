-- ============================================================
-- Test — 0071: una cortesía silenciada cuenta como si no hubiera llegado.
--
-- Cada inbound cancela los nudges y reactiva la conversación al entrar. Cuando el
-- courtesy gate calla el turno, app_restore_after_courtesy deshace ambas cosas, pero
-- SÓLO lo que hicieron los mensajes desde p_since. `pnpm test:unit` mockea db/queries:
-- esto sólo se prueba aquí.
--
--   psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
--     -v ON_ERROR_STOP=1 -f supabase/tests/0071_courtesy_skip.test.sql
--
-- Corre dentro de una transacción y hace ROLLBACK: no deja rastro.
-- ============================================================

\set ON_ERROR_STOP on
BEGIN;

DO $$
DECLARE
  v_client uuid;
  v_conv   uuid;
  v_ghl    text := 'test-0071-conv';
  v_old    uuid;
  v_new    uuid;
  v_since  timestamptz;
  v_res    jsonb;
  v_status text;
  v_fu     text;
BEGIN
  SELECT id INTO v_client FROM public.clients LIMIT 1;
  IF v_client IS NULL THEN
    RAISE EXCEPTION 'no hay clients sembrados — corre `supabase db reset` primero';
  END IF;

  -- Una cita agendada: la conversación está completed.
  INSERT INTO public.conversations (client_id, channel, ghl_conversation_id, ghl_contact_id, status)
  VALUES (v_client, 'whatsapp', v_ghl, 'test-0071-contact', 'completed')
  RETURNING id INTO v_conv;

  -- 1. un inbound la reactiva y recuerda de dónde venía
  PERFORM public.app_reactivate_conversation(v_ghl);
  SELECT status INTO v_status FROM public.conversations WHERE id = v_conv;
  ASSERT v_status = 'active', format('debió reactivarse: %s', v_status);
  ASSERT (SELECT reactivated_from FROM public.conversations WHERE id = v_conv) = 'completed',
    'debió recordar completed';

  -- 2. una segunda reactivación (ráfaga) no pisa el status recordado
  PERFORM public.app_reactivate_conversation(v_ghl);
  ASSERT (SELECT reactivated_from FROM public.conversations WHERE id = v_conv) = 'completed',
    'una conversación ya activa no debe sobreescribir reactivated_from';

  -- 3. restaurar regresa a completed y limpia el rastro
  v_res := public.app_restore_after_courtesy(v_conv, now() - interval '1 minute');
  SELECT status INTO v_status FROM public.conversations WHERE id = v_conv;
  ASSERT v_status = 'completed', format('debió volver a completed: %s / %s', v_status, v_res);
  ASSERT v_res->>'status' = 'completed', format('el RPC debió reportar completed: %s', v_res);
  ASSERT (SELECT reactivated_from FROM public.conversations WHERE id = v_conv) IS NULL, 'debió limpiar reactivated_from';

  -- 4. nudges: uno cancelado ANTES de p_since (otro inbound, otra historia) y uno por la cortesía
  UPDATE public.conversations SET status = 'active' WHERE id = v_conv;
  INSERT INTO public.follow_ups (conversation_id, tier, status, scheduled_for, cancelled_at)
  VALUES (v_conv, 1, 'cancelled', now() + interval '1 hour', now() - interval '2 hours')
  RETURNING id INTO v_old;
  INSERT INTO public.follow_ups (conversation_id, tier, status, scheduled_for)
  VALUES (v_conv, 1, 'pending', now() + interval '2 hours')
  RETURNING id INTO v_new;
  v_since := now();
  PERFORM public.app_cancel_follow_ups(v_conv);
  ASSERT (SELECT cancelled_at FROM public.follow_ups WHERE id = v_new) IS NOT NULL, 'cancelar debió estampar cancelled_at';

  v_res := public.app_restore_after_courtesy(v_conv, v_since);
  SELECT status INTO v_fu FROM public.follow_ups WHERE id = v_new;
  ASSERT v_fu = 'pending', format('el nudge que canceló la cortesía debió volver a pending: %s', v_fu);
  SELECT status INTO v_fu FROM public.follow_ups WHERE id = v_old;
  ASSERT v_fu = 'cancelled', 'un nudge cancelado antes de p_since no se toca';
  ASSERT (v_res->>'followUps')::int = 1, format('debió reportar 1 nudge: %s', v_res);

  -- 5. una conversación que nadie reactivó (ya estaba active) no cambia de status
  ASSERT v_res->'status' = 'null'::jsonb, format('sin reactivación no hay status que restaurar: %s', v_res);
  SELECT status INTO v_status FROM public.conversations WHERE id = v_conv;
  ASSERT v_status = 'active', 'debió seguir active';

  -- 6. si otra cosa movió el status después (p. ej. awaiting_human por tag), no se pisa
  UPDATE public.conversations SET status = 'standby' WHERE id = v_conv;
  PERFORM public.app_reactivate_conversation(v_ghl);
  UPDATE public.conversations SET status = 'awaiting_human' WHERE id = v_conv;
  v_res := public.app_restore_after_courtesy(v_conv, now() - interval '1 minute');
  SELECT status INTO v_status FROM public.conversations WHERE id = v_conv;
  ASSERT v_status = 'awaiting_human', format('no debió pisar awaiting_human: %s', v_status);

  -- 7. el evento nuevo pasa el CHECK
  INSERT INTO public.bot_events (client_id, conversation_id, event_type, metadata)
  VALUES (v_client, v_conv, 'courtesy_skipped', '{}'::jsonb);

  RAISE NOTICE '0071 courtesy skip: OK';
END;
$$;

ROLLBACK;
