-- ============================================================
-- Migration 0050 — "dato pendiente": la cola de lo que el bot NO supo
-- The Bot Crew · Agent Platform
--
-- Hasta hoy, cuando el lead preguntaba algo que no está en la config (formas de
-- pago, una política, un precio que el cliente nunca nos dio), el bot pedía
-- permiso: "¿quieres que lo pregunte?". Eso es malo por dos razones:
--   · frente al lead — pedir permiso para hacer tu trabajo suena inseguro, y su
--     respuesta ("sí, porfa") gasta un turno que no mueve nada;
--   · frente a nosotros — la duda se pierde en el hilo. Nadie se entera de que a
--     la configuración le faltaba un dato, así que el hueco nunca se tapa y el
--     siguiente lead choca con el mismo.
--
-- El comportamiento nuevo: el bot AFIRMA que lo confirma con el equipo y marca la
-- conversación. Eso necesita una cola, y la cola tiene que ser SEPARADA de
-- `awaiting_human_tag`:
--
--   awaiting_human_tag (0034) → "hay que agendarle"     → la atiende el CLIENTE.
--   pending_info_tag   (aquí) → "al bot le faltó un dato" → la atiende QUIEN OPERA
--                                                            la plataforma.
--
-- Con un solo tag las dos colas se mezclan y la señal se pierde justo donde vale:
-- la recepcionista contesta la duda, quita el tag, y nadie aprende que el prompt
-- tenía un hueco. Son dos audiencias, dos acciones y dos tiempos de respuesta.
--
-- El ESTADO sí es el mismo (`awaiting_human`): la semántica de 0035 aplica igual
-- —le debemos una respuesta a esta lead, así que mandarle "¿sigues interesada?"
-- es al revés—, el bot NO se muda, y quitar el tag en GHL la regresa a 'active' y
-- re-arma los recordatorios. El tag handler trata los dos tags como la misma
-- señal (ver worker/tag-handler.ts).
--
-- NULL = el tenant no usa esta cola: el bot igual promete confirmar y marca el
-- estado, sólo que no escribe tag. Mismo criterio que 0034.
-- ============================================================

alter table tenant_config
  add column if not exists pending_info_tag text;

comment on column tenant_config.pending_info_tag is
  'Tag que el bot pone en el contacto de GHL cuando el lead preguntó algo que NO está en su configuración y prometió confirmarlo con el equipo (p.ej. ''dato-pendiente''). Cola de revisión de quien opera la plataforma, distinta de awaiting_human_tag (cola de agendado del cliente). NULL = el tenant no usa esta señal.';

-- ------------------------------------------------------------
-- Evento de observabilidad. Es la mitad que de verdad cierra el ciclo: el tag se
-- quita al atender (y se pierde), el evento queda. Su payload trae la pregunta
-- textual del lead, así que `bot_events` se vuelve la lista priorizada de qué le
-- falta a cada config — por tenant y por frecuencia.
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
    'followup_aborted', 'demo_reminder_sent', 'status_change_blocked',
    'attachment_received', 'attachment_failed',
    'capi_event_sent', 'capi_error',
    'reactivation_exhausted', 'pending_info'
  ]));
