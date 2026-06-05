-- ============================================================
-- Migration 0005 — conversation store (we own the history)
-- The Bot Crew · Agent Platform
--
-- Turns `messages` from a metadata-only stats table into the canonical
-- conversation store: full message content + sender attribution (who sent what —
-- the lead, which AI role, or which human agent). This removes any dependency on
-- GHL for conversation history (rate limits / lock-in) and lays the groundwork for
-- human-agent <-> AI collaboration.
-- ============================================================

-- ------------------------------------------------------------
-- HUMAN_AGENTS — roster of humans who can collaborate with the AI in a thread.
-- Minimal for now (no auth yet); messages.human_agent_id references this.
-- ------------------------------------------------------------
create table if not exists human_agents (
  id         uuid primary key default gen_random_uuid(),
  client_id  uuid references clients(id) on delete set null,  -- null = agency-wide
  name       text not null,
  email      text unique,
  is_active  boolean default true,
  created_at timestamptz default now()
);

create index if not exists idx_human_agents_client_id on human_agents(client_id);

-- ------------------------------------------------------------
-- MESSAGES — add content + attribution columns.
--   content        : the actual message body (PII lives here from now on)
--   agent_role     : which AI role produced a 'bot' message (e.g. 'front-desk')
--   human_agent_id : which human produced a 'human_agent' message
--   model          : the model used for a 'bot' message (provenance)
-- message_length stays and is derived from content in the RPC below.
-- ------------------------------------------------------------
alter table messages
  add column if not exists content        text,
  add column if not exists agent_role     text,
  add column if not exists human_agent_id uuid references human_agents(id),
  add column if not exists model          text;

create index if not exists idx_messages_human_agent_id on messages(human_agent_id);

-- ------------------------------------------------------------
-- RLS — deny-by-default now that conversations/messages hold PII text.
-- The Worker (service_role) bypasses RLS. The reporting views (client_summary,
-- monthly_activity) are owned by postgres and keep working. Dashboard policies later.
-- ------------------------------------------------------------
alter table messages      enable row level security;
alter table conversations enable row level security;

-- ============================================================
-- Recreate app_log_message with the richer signature.
-- (Single canonical function — the old metadata-only signature is dropped.)
-- ============================================================
drop function if exists app_log_message(text, uuid, text, text, text, text, text, int, timestamptz);

create or replace function app_log_message(
  p_ghl_conversation_id text,
  p_client_id           uuid,
  p_channel             text,
  p_ghl_contact_id      text,
  p_contact_phone       text,
  p_direction           text,   -- 'inbound' | 'outbound'
  p_sender_type         text,   -- 'lead' | 'bot' | 'human_agent'
  p_content             text,   -- the message body
  p_agent_role          text,   -- which AI role (null unless sender_type = 'bot')
  p_human_agent_id      uuid,   -- which human (null unless sender_type = 'human_agent')
  p_model               text,   -- model used (null unless sender_type = 'bot')
  p_sent_at             timestamptz
) returns uuid
language plpgsql
as $$
declare
  v_conv_id uuid;
  v_channel text;
  v_ts      timestamptz := coalesce(p_sent_at, now());
begin
  -- Normalize the channel GHL sends ('WhatsApp', 'IG', etc.)
  v_channel := case
    when lower(p_channel) like '%insta%' or upper(p_channel) = 'IG' then 'instagram'
    else 'whatsapp'
  end;

  -- Upsert the conversation by ghl_conversation_id
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

  -- Insert the message — now WITH content + attribution.
  insert into messages (
    conversation_id, direction, sender_type, sent_at,
    message_length, content, agent_role, human_agent_id, model
  ) values (
    v_conv_id, p_direction, p_sender_type, v_ts,
    char_length(coalesce(p_content, '')), p_content, p_agent_role, p_human_agent_id, p_model
  );

  return v_conv_id;
end;
$$;
