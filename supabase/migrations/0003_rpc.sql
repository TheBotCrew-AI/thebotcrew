-- ============================================================
-- Migration 0002 — ghl keys + rpc functions
-- The Bot Crew · Stats & Proof Database
--
-- Renombra este archivo a supabase/migrations/<timestamp>_rpc.sql
-- con un timestamp MAYOR al del init (p.ej. 20250604010000_rpc.sql)
-- ============================================================

-- ------------------------------------------------------------
-- 1. Llaves externas de GHL
-- ------------------------------------------------------------
alter table conversations
  add column if not exists ghl_conversation_id text,
  add column if not exists ghl_contact_id      text;

-- Unique index → habilita el ON CONFLICT del upsert
create unique index if not exists uq_conversations_ghl_conv_id
  on conversations(ghl_conversation_id);

create index if not exists idx_conversations_ghl_contact_id
  on conversations(ghl_contact_id);

alter table appointments
  add column if not exists ghl_appointment_id text;

create index if not exists idx_appointments_ghl_appt_id
  on appointments(ghl_appointment_id);

-- ============================================================
-- 2. FUNCIÓN: registrar un mensaje
--    Hace upsert de la conversación + inserta el mensaje.
--    Devuelve el UUID interno de la conversación.
-- ============================================================
create or replace function app_log_message(
  p_ghl_conversation_id text,
  p_client_id           uuid,
  p_channel             text,
  p_ghl_contact_id      text,
  p_contact_phone       text,
  p_direction           text,   -- 'inbound' | 'outbound'
  p_sender_type         text,   -- 'lead' | 'bot' | 'human_agent'
  p_message_length      int,
  p_sent_at             timestamptz
) returns uuid
language plpgsql
as $$
declare
  v_conv_id uuid;
  v_channel text;
  v_ts      timestamptz := coalesce(p_sent_at, now());
begin
  -- Normaliza el canal que manda GHL ('WhatsApp', 'IG', etc.)
  v_channel := case
    when lower(p_channel) like '%insta%' or upper(p_channel) = 'IG' then 'instagram'
    else 'whatsapp'
  end;

  -- Upsert de la conversación por ghl_conversation_id
  insert into conversations (
    client_id, channel, ghl_conversation_id, ghl_contact_id,
    contact_phone, started_at, last_message_at, status
  ) values (
    p_client_id, v_channel, p_ghl_conversation_id, p_ghl_contact_id,
    p_contact_phone, v_ts, v_ts, 'active'
  )
  on conflict (ghl_conversation_id) do update set
    last_message_at = greatest(conversations.last_message_at, excluded.last_message_at),
    contact_phone   = coalesce(conversations.contact_phone, excluded.contact_phone),
    ghl_contact_id  = coalesce(conversations.ghl_contact_id, excluded.ghl_contact_id)
  returning id into v_conv_id;

  -- Inserta el mensaje (sin texto, solo metadata)
  insert into messages (
    conversation_id, direction, sender_type, sent_at, message_length
  ) values (
    v_conv_id, p_direction, p_sender_type, v_ts, p_message_length
  );

  return v_conv_id;
end;
$$;

-- ============================================================
-- 3. FUNCIÓN: registrar una cita (booked / rescheduled / cancelled)
--    Liga la cita a la conversación más reciente del contacto.
--    Devuelve el UUID de la cita.
-- ============================================================
create or replace function app_log_appointment(
  p_client_id            uuid,
  p_ghl_contact_id       text,
  p_action               text,   -- 'booked' | 'rescheduled' | 'cancelled'
  p_appointment_datetime timestamptz,
  p_service_type         text,
  p_source               text,
  p_ghl_appointment_id   text
) returns uuid
language plpgsql
as $$
declare
  v_conv_id uuid;
  v_appt_id uuid;
begin
  -- Busca la conversación activa más reciente de este contacto
  select id into v_conv_id
  from conversations
  where ghl_contact_id = p_ghl_contact_id
    and client_id = p_client_id
  order by last_message_at desc
  limit 1;

  insert into appointments (
    conversation_id, client_id, action, appointment_datetime,
    service_type, source, ghl_appointment_id
  ) values (
    v_conv_id, p_client_id, p_action, p_appointment_datetime,
    p_service_type, p_source, p_ghl_appointment_id
  )
  returning id into v_appt_id;

  -- Si se agendó, marca el outcome de la conversación
  if p_action = 'booked' and v_conv_id is not null then
    update conversations
    set outcome = 'appointment_booked'
    where id = v_conv_id;
  end if;

  return v_appt_id;
end;
$$;

-- ============================================================
-- 3b. FUNCIÓN: reagendar / cancelar por eventId
--     El payload de GHL solo trae el eventId (= ghl_appointment_id
--     de la cita original) y, en reagendar, la nueva fecha.
--     Esta función resuelve client_id y conversación hacia atrás
--     desde la cita 'booked' original.
-- ============================================================
create or replace function app_log_reschedule_cancel(
  p_ghl_appointment_id   text,
  p_action               text,        -- 'rescheduled' | 'cancelled'
  p_appointment_datetime timestamptz  -- nueva fecha (reagendar) o null (cancelar)
) returns uuid
language plpgsql
as $$
declare
  v_conv_id     uuid;
  v_client_id   uuid;
  v_service     text;
  v_new_appt_id uuid;
begin
  -- Busca la cita original (la más reciente con ese eventId de GHL)
  select conversation_id, client_id, service_type
    into v_conv_id, v_client_id, v_service
  from appointments
  where ghl_appointment_id = p_ghl_appointment_id
  order by created_at desc
  limit 1;

  -- Si no encontramos la cita original, igual registramos la acción
  -- (sin conversación ligada) para no perder el conteo.
  insert into appointments (
    conversation_id, client_id, action, appointment_datetime,
    service_type, ghl_appointment_id
  ) values (
    v_conv_id, v_client_id, p_action, p_appointment_datetime,
    v_service, p_ghl_appointment_id
  )
  returning id into v_new_appt_id;

  return v_new_appt_id;
end;
$$;

-- ============================================================
-- 4. FUNCIÓN: registrar un evento de valor (bot_events)
-- ============================================================
create or replace function app_log_event(
  p_client_id           uuid,
  p_ghl_conversation_id text,
  p_event_type          text,
  p_metadata            jsonb
) returns uuid
language plpgsql
as $$
declare
  v_conv_id  uuid;
  v_event_id uuid;
begin
  select id into v_conv_id
  from conversations
  where ghl_conversation_id = p_ghl_conversation_id
  limit 1;

  insert into bot_events (client_id, conversation_id, event_type, metadata)
  values (p_client_id, v_conv_id, p_event_type, coalesce(p_metadata, '{}'::jsonb))
  returning id into v_event_id;

  return v_event_id;
end;
$$;

-- ============================================================
-- 5. FUNCIÓN: marcar handoff a humano
-- ============================================================
create or replace function app_set_handoff(
  p_ghl_conversation_id text
) returns void
language plpgsql
as $$
begin
  update conversations
  set status            = 'handed_off',
      handoff_triggered = true,
      last_message_at   = now()
  where ghl_conversation_id = p_ghl_conversation_id;
end;
$$;
