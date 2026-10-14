-- ============================================================
-- Migration 0071 — courtesy skip: el bot se despide UNA vez
-- The Bot Crew · Agent Platform
--
-- Después de que el bot ya se despidió ("¡Con mucho gusto, Perla! Te esperamos"), un
-- "gracias" / 👍 / "bendiciones" del lead recibía otra respuesta, y el lead contestaba
-- a ésa, y así. El turno ahora se queda callado en ese caso (worker/courtesy-gate.ts).
--
-- Callarse no basta: cada inbound, al entrar, CANCELA los nudges pendientes y REACTIVA
-- la conversación (completed/standby → active), y ninguna de las dos cosas guardaba lo
-- que había antes. Un 👍 a una cita agendada dejaba la conversación `active` para
-- siempre; un "ok gracias" a mitad del embudo apagaba la cadencia. Esta migración
-- registra ambas cosas y agrega el RPC que las deshace: el mensaje de cortesía cuenta
-- como si no hubiera llegado.
--
-- Expand-only: el Worker viejo llama los mismos RPCs con los mismos argumentos y no lee
-- las columnas nuevas. Orden: esta migración PRIMERO, luego el Worker (el evento
-- `courtesy_skipped` viola el CHECK viejo y se pierde en silencio).
-- ============================================================

-- follow_ups.cancelled_at: cuándo lo canceló un inbound.
ALTER TABLE public.follow_ups ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;

CREATE OR REPLACE FUNCTION public.app_cancel_follow_ups(p_conversation_id uuid)
 RETURNS void
 LANGUAGE sql
AS $function$
  UPDATE public.follow_ups
  SET status = 'cancelled', cancelled_at = now()
  WHERE conversation_id = p_conversation_id
    AND status IN ('pending', 'processing', 'sending');
$function$;

-- conversations.reactivated_from/_at: el status que tenía antes de que un inbound la
-- reactivara. Sólo se escribe cuando la reactivación de verdad cambia algo.
ALTER TABLE public.conversations ADD COLUMN IF NOT EXISTS reactivated_from text;
ALTER TABLE public.conversations ADD COLUMN IF NOT EXISTS reactivated_at timestamptz;

CREATE OR REPLACE FUNCTION public.app_reactivate_conversation(p_ghl_conversation_id text)
 RETURNS void
 LANGUAGE sql
AS $function$
  UPDATE public.conversations
  SET reactivated_from = status, reactivated_at = now(), status = 'active'
  WHERE ghl_conversation_id = p_ghl_conversation_id
    AND status IN ('standby', 'completed');
$function$;

-- Deshace lo que hicieron los inbounds de cortesía desde p_since (el primero de ellos):
-- los nudges que cancelaron vuelven a `pending` con su hora original, y si la
-- conversación sigue `active` porque ELLOS la reactivaron, regresa al status anterior.
-- Un nudge con hora ya vencida sale en el siguiente tick del runner, que vuelve a
-- revisar pausa humana y quiet hours al enviar (0067). Un row que el runner tenía en
-- `processing` no se envía dos veces: su commit gate exige `processing` (0043).
CREATE OR REPLACE FUNCTION public.app_restore_after_courtesy(
  p_conversation_id uuid,
  p_since timestamptz
)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_follow_ups int;
  v_status text;
BEGIN
  UPDATE public.follow_ups
  SET status = 'pending', cancelled_at = NULL
  WHERE conversation_id = p_conversation_id
    AND status = 'cancelled'
    AND cancelled_at >= p_since;
  GET DIAGNOSTICS v_follow_ups = ROW_COUNT;

  UPDATE public.conversations
  SET status = reactivated_from, reactivated_from = NULL, reactivated_at = NULL
  WHERE id = p_conversation_id
    AND status = 'active'
    AND reactivated_from IS NOT NULL
    AND reactivated_at >= p_since
  RETURNING status INTO v_status;

  RETURN jsonb_build_object('followUps', v_follow_ups, 'status', v_status);
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.app_restore_after_courtesy(uuid, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_restore_after_courtesy(uuid, timestamptz) TO service_role;

-- courtesy_skipped: {messageId, restored} — el turno se calló ante cortesía después de
-- la despedida del bot. La lista es la ACTUAL de prod (0067) más el nuevo tipo.
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
    'followup_aborted', 'demo_reminder_sent', 'status_change_blocked',
    'attachment_received', 'attachment_failed',
    'capi_event_sent', 'capi_error',
    'reactivation_exhausted', 'pending_info',
    'resume_skipped',
    'pending_info_escalated', 'info_gap_error',
    'interest_tagged',
    'turn_answered',
    'hold_created', 'hold_released', 'hold_expired', 'booking_paid', 'booking_paid_late',
    'payment_error', 'hold_reminder_sent',
    'prime_time_released',
    'stage_changed',
    'courtesy_skipped'
  ]));
