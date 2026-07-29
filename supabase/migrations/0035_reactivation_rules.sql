-- ============================================================
-- Migration 0035 — reglas de reactivación por caso
-- The Bot Crew · Agent Platform
--
-- `status = 'active'` es, funcionalmente, la única llave que habilita follow-ups
-- (`app_schedule_follow_up` y `app_load_due_follow_ups` exigen 'active'). Por eso
-- "reactivar" NO es revivir la conversación —el bot nunca estuvo mudo salvo en
-- handed_off—, es **volver a armar los recordatorios automáticos**.
--
-- Hasta hoy la reactivación era uniforme: cualquier mensaje entrante revivía
-- standby, completed y opted_out por igual. Eso está mal en dos casos, por razones
-- distintas, y la pregunta correcta es "¿tenemos derecho a volver a picarle?":
--
--   · se enfrió / no calificó  → SÍ. Volvió sola, es una lead viva otra vez.
--   · opted_out                → NO. Pidió que no le escribieran. Que escriba no
--     equivale a volver a dar permiso de perseguirla. Esto era un bug de
--     cumplimiento en producción, sin relación con ningún cliente en particular.
--   · esperando a una persona  → NO. Nosotros le debemos la respuesta a ella;
--     mandarle "¿sigues interesada?" es exactamente al revés.
--
-- El tercer caso necesita un estado propio porque es el único con semántica de
-- reactivación distinta. NO silencia al bot (app_is_bot_suppressed sigue mirando
-- solo handed_off), así que la lead puede seguir preguntando precios y recibir
-- respuesta: lo único que se apaga son los recordatorios.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Nuevo valor de estado.
-- ------------------------------------------------------------
ALTER TABLE public.conversations DROP CONSTRAINT IF EXISTS conversations_status_check;
ALTER TABLE public.conversations ADD CONSTRAINT conversations_status_check
  CHECK (status = ANY (ARRAY[
    'active', 'closed', 'handed_off', 'standby', 'opted_out', 'completed', 'awaiting_human'
  ]));

-- ------------------------------------------------------------
-- 2. Reactivación selectiva. Fuera `opted_out`; `awaiting_human` nunca entra.
-- ------------------------------------------------------------
create or replace function app_reactivate_conversation(p_ghl_conversation_id text)
returns void
language sql
as $$
  UPDATE public.conversations
  SET status = 'active'
  WHERE ghl_conversation_id = p_ghl_conversation_id
    AND status IN ('standby', 'completed');
$$;

comment on function app_reactivate_conversation(text) is
  'Re-arma los follow-ups cuando la lead vuelve. Excluye opted_out (revocó el permiso) y awaiting_human (le debemos una respuesta): en ambos el bot igual contesta, pero no reanuda recordatorios.';

-- ------------------------------------------------------------
-- 3. Toggle por contacto, manejado por el tag de GHL (ContactTagUpdate).
--    Simétrico a `bot-off`: el tag es la fuente de verdad operativa, así que
--    quitarlo —la acción real de la persona al atender— devuelve la conversación
--    a 'active' y los recordatorios vuelven a estar disponibles.
--
--    No pisa handed_off ni opted_out: son señales más fuertes que ésta.
-- ------------------------------------------------------------
create or replace function app_set_awaiting_human_by_contact(
  p_ghl_contact_id text,
  p_awaiting       boolean
) returns int
language plpgsql
as $$
DECLARE
  v_row     record;
  v_count   int := 0;
  v_new     text := case when p_awaiting then 'awaiting_human' else 'active' end;
BEGIN
  FOR v_row IN
    SELECT id, client_id, status
    FROM public.conversations
    WHERE ghl_contact_id = p_ghl_contact_id
      AND CASE
            WHEN p_awaiting THEN status NOT IN ('awaiting_human', 'handed_off', 'opted_out')
            ELSE status = 'awaiting_human'
          END
    FOR UPDATE
  LOOP
    UPDATE public.conversations SET status = v_new WHERE id = v_row.id;

    INSERT INTO public.bot_events (client_id, conversation_id, event_type, metadata)
    VALUES (v_row.client_id, v_row.id, 'status_changed',
            jsonb_build_object('from', v_row.status, 'to', v_new, 'via', 'awaiting_human_tag'));

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$;

revoke all on function app_set_awaiting_human_by_contact(text, boolean) from public, anon, authenticated;
grant execute on function app_set_awaiting_human_by_contact(text, boolean) to service_role;
revoke all on function app_reactivate_conversation(text) from public, anon, authenticated;
grant execute on function app_reactivate_conversation(text) to service_role;
