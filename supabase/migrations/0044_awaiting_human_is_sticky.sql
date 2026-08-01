-- ============================================================
-- Migration 0044 — `awaiting_human` no se pisa con un estado reactivable
-- The Bot Crew · Agent Platform
--
-- 0035 dejó `awaiting_human` fuera de `app_reactivate_conversation`: la lead
-- puede volver a escribir, el bot le contesta, y los recordatorios NO se
-- re-arman, porque la respuesta se la debemos nosotros. El candado real, sin
-- embargo, es el valor del estado — y `app_update_conversation_status` escribe
-- ese valor sin mirar el que ya está.
--
-- El agujero, en orden:
--   1. la lead queda en `awaiting_human` (tag `esperando-agenda` en GHL),
--   2. el clasificador de fin de turno —o la tool del modelo— decide `standby`
--      o `completed` y lo escribe encima,
--   3. la lead vuelve a escribir → `app_reactivate_conversation` SÍ levanta esos
--      dos → `active` → la cadencia se re-arma.
--
-- Resultado: le mandamos "¿sigues interesada?" a alguien que sigue con el tag
-- puesto esperando que una persona le conteste. Exactamente lo que 0035 quería
-- impedir, por una puerta lateral. En prod no se ha disparado (las únicas
-- salidas de `awaiting_human` fueron el tag y re-marcados sobre sí mismo), pero
-- hoy no lo impide nada.
--
-- La regla: el TAG es la fuente de verdad. Solo quitarlo —el acto real de
-- "ya la atendí"— saca a la conversación de `awaiting_human`
-- (`app_set_awaiting_human_by_contact`). Un estado escrito por el modelo no.
--
-- Las señales MÁS fuertes sí pasan, con la misma precedencia que ya usa
-- `app_set_awaiting_human_by_contact`:
--   · handed_off → pasa. Silencia al bot; nadie lo reactiva por mensaje.
--   · opted_out  → pasa. La lead revocó el permiso: eso gana sobre todo, y
--                  tampoco es reactivable (0035).
--   · standby / completed → bloqueados: son los DOS únicos reactivables, o sea
--                  exactamente los que abren la puerta.
--
-- Un `completed` bloqueado (la bot alcanzó a agendar sola) deja el tag puesto
-- hasta que una persona lo quite. Es el lado correcto en el que fallar: la
-- consecuencia es un tag de más en GHL, no un nudge de más a la lead.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Nuevo evento: la transición que NO ocurrió.
--    Sin esto el bloqueo es invisible — el mismo error que hizo que la carrera
--    de envío de 0043 no se viera durante semanas.
-- ------------------------------------------------------------
ALTER TABLE public.bot_events DROP CONSTRAINT IF EXISTS bot_events_event_type_check;
ALTER TABLE public.bot_events ADD CONSTRAINT bot_events_event_type_check
  CHECK (event_type = ANY (ARRAY[
    'lead_qualified', 'follow_up_sent', 'no_show_recovered', 'out_of_hours_handled',
    'objection_handled', 'reactivation_sent', 'agent_error', 'db_error', 'delivery_error',
    'run_superseded', 'run_suppressed', 'handoff_tag_on', 'handoff_tag_off',
    'channel_disabled', 'test_mode_skip', 'keyword_required', 'bot_activated',
    'availability_checked', 'booking_failed', 'status_changed', 'turn_scheduled',
    'demo_toggled', 'ai_key_fallback', 'awaiting_human', 'variant_assigned',
    'demo_session_started', 'demo_session_ended', 'lead_disqualified',
    'followup_aborted', 'demo_reminder_sent', 'status_change_blocked'
  ]));

-- ------------------------------------------------------------
-- 2. El guard.
--
--    Cambia el tipo de retorno (void → boolean), así que hay que soltar la
--    función primero. Es compatible hacia atrás: el Worker desplegado llama por
--    nombre e ignora el valor. La dirección que NO es compatible es la otra —
--    el Worker nuevo lee el boolean y trata `null` (lo que devuelve la versión
--    void) como bloqueado. **Aplicar esta migración ANTES del deploy.**
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS public.app_update_conversation_status(text, text);

CREATE FUNCTION public.app_update_conversation_status(
  p_ghl_conversation_id text,
  p_status              text
) RETURNS boolean
LANGUAGE plpgsql AS $$
DECLARE
  v_conv_id   uuid;
  v_client_id uuid;
  v_old       text;
BEGIN
  SELECT id, client_id, status INTO v_conv_id, v_client_id, v_old
  FROM public.conversations
  WHERE ghl_conversation_id = p_ghl_conversation_id;

  IF v_conv_id IS NULL THEN
    RETURN false;
  END IF;

  IF v_old = 'awaiting_human' AND p_status IN ('standby', 'completed') THEN
    -- La intención sí se honra en lo que importa: nada de recordatorios. Solo
    -- se rechaza el cambio de VALOR, que es lo que abriría la reactivación.
    PERFORM public.app_cancel_follow_ups(v_conv_id);

    INSERT INTO public.bot_events (client_id, conversation_id, event_type, metadata)
    VALUES (v_client_id, v_conv_id, 'status_change_blocked',
            jsonb_build_object('from', v_old, 'to', p_status, 'why', 'awaiting_human_is_sticky'));

    RETURN false;
  END IF;

  UPDATE public.conversations SET status = p_status WHERE id = v_conv_id;
  PERFORM public.app_cancel_follow_ups(v_conv_id);

  INSERT INTO public.bot_events (client_id, conversation_id, event_type, metadata)
  VALUES (v_client_id, v_conv_id, 'status_changed',
          jsonb_build_object('from', v_old, 'to', p_status));

  RETURN true;
END;
$$;

COMMENT ON FUNCTION public.app_update_conversation_status(text, text) IS
  'Cambia el estado y cancela los follow-ups pendientes. Devuelve false si no aplicó: '
  'conversación inexistente, o un intento de pisar awaiting_human con standby/completed '
  '(los dos estados reactivables — solo quitar el tag saca de awaiting_human). '
  'false ⇒ el llamador NO debe escribir el tag de estado en GHL.';

-- ------------------------------------------------------------
-- 3. Grants — regla de 0032: SECURITY INVOKER, revocado de PUBLIC (no solo de
--    anon: Postgres otorga EXECUTE a PUBLIC por defecto), otorgado a
--    service_role. El DROP se llevó los grants viejos, así que esto no es
--    ceremonia: sin estas dos líneas la función queda expuesta al Data API.
-- ------------------------------------------------------------
REVOKE ALL ON FUNCTION public.app_update_conversation_status(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.app_update_conversation_status(text, text) TO service_role;
