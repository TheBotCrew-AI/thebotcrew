-- ============================================================
-- Migration 0034 — etiqueta de "en espera de atención humana"
-- The Bot Crew · Agent Platform
--
-- Caso: MADI no agenda por bot (renta una caseta en el calendario de un tercero).
-- El bot recoge la solicitud y una persona agenda. Hacía falta una señal operativa
-- para que esa persona encuentre al lead en GHL.
--
-- Se resuelve con un TAG configurable por tenant, no con un estado nuevo: el enum
-- `conversations.status` ya carga tres significados encimados (quién habla, en qué
-- acabó, si mandamos follow-ups) y meterle un cuarto valor empeoraría eso.
--
-- NULL = el tenant no usa esta señal (comportamiento actual, ningún tenant afectado).
-- ============================================================

alter table tenant_config
  add column if not exists awaiting_human_tag text;

comment on column tenant_config.awaiting_human_tag is
  'Tag que el bot pone en el contacto de GHL cuando deja una solicitud lista para que una persona la atienda (p.ej. ''esperando-agenda''). NULL = el tenant no usa esta señal. Lo quita la persona al atender.';

-- Evento de observabilidad: cuándo el bot dejó una solicitud esperando a un humano.
-- Es lo que permite medir cuánto tarda el equipo en atenderla.
ALTER TABLE public.bot_events DROP CONSTRAINT IF EXISTS bot_events_event_type_check;
ALTER TABLE public.bot_events ADD CONSTRAINT bot_events_event_type_check
  CHECK (event_type = ANY (ARRAY[
    'lead_qualified', 'follow_up_sent', 'no_show_recovered', 'out_of_hours_handled',
    'objection_handled', 'reactivation_sent', 'agent_error', 'db_error', 'delivery_error',
    'run_superseded', 'run_suppressed', 'handoff_tag_on', 'handoff_tag_off',
    'channel_disabled', 'test_mode_skip', 'keyword_required', 'bot_activated',
    'availability_checked', 'booking_failed', 'status_changed', 'turn_scheduled',
    'demo_toggled', 'ai_key_fallback', 'awaiting_human'
  ]));
