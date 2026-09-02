-- ============================================================
-- Migration 0060 — evento `turn_answered`: el double-run guard deja de tirar mensajes
-- The Bot Crew · Agent Platform
--
-- El guard de doble corrida (0d4781c, 2026-08-27) decidía "ya contestaron" con
-- `hasReplyAfter`: cualquier outbound posterior al inbound del turno. Falso positivo:
-- el turno del mensaje ANTERIOR sigue generando mientras entra el mensaje nuevo, su
-- respuesta cae después del nuevo inbound, y el turno del nuevo se salta con
-- `run_superseded {reason:'already_answered'}` sin haber corrido. 22 mensajes en 6 días
-- (Heriberto 2026-09-02: "¿Puede ser valoración sin costo?" nunca se contestó).
--
-- La pregunta correcta es "¿ya contestó un run que TENÍA este mensaje en su historia?",
-- y eso sólo lo sabe el run mismo. Por eso el turno emite `turn_answered {messageId}`
-- al registrar su respuesta y el guard busca ese evento por messageId. Un double-run
-- genuino (DO + fallback, o DO + rescate de retry de GHL) lleva el MISMO messageId, así
-- que el segundo sigue viendo el evento del primero y se detiene.
--
-- Expand-only: el Worker viejo no escribe el evento y no lo lee. Orden de despliegue:
-- esta migración PRIMERO, luego el Worker — al revés, `logBotEvent` viola el CHECK
-- (falla en silencio, la escritura se pierde) y el guard nunca vería el evento.
-- ============================================================

-- turn_answered: {messageId} — escrito por runAgentTurn justo antes de enviar la
-- respuesta, una vez por turno. La lista es la ACTUAL de prod (0058) más el nuevo tipo.
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
    'turn_answered'
  ]));

-- El guard busca por (conversation_id, metadata->>'messageId'); sin índice es un scan
-- por conversación, que ya está indexada — suficiente hoy, pero el índice parcial es
-- barato y mantiene el guard O(1) cuando bot_events crezca.
CREATE INDEX IF NOT EXISTS idx_bot_events_turn_answered
  ON public.bot_events (conversation_id, (metadata->>'messageId'))
  WHERE event_type = 'turn_answered';
