-- ============================================================
-- Migration 0001 — init
-- The Bot Crew · Stats & Proof Database
-- ============================================================

create extension if not exists "pgcrypto";

-- ============================================================
-- CLIENTS
-- ============================================================
create table if not exists clients (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  niche        text,                     -- 'clinic' | 'gym' | 'real_estate' | 'coaching'
  country      text default 'MX',
  active_since date default current_date,
  is_active    boolean default true,
  created_at   timestamptz default now()
);

-- ============================================================
-- CONVERSATIONS
-- ============================================================
create table if not exists conversations (
  id                uuid primary key default gen_random_uuid(),
  client_id         uuid not null references clients(id) on delete cascade,
  channel           text not null check (channel in ('whatsapp', 'instagram')),
  contact_phone     text,
  started_at        timestamptz default now(),
  last_message_at   timestamptz default now(),
  status            text default 'active' check (status in ('active', 'closed', 'handed_off')),
  outcome           text check (outcome in (
                      'appointment_booked',
                      'qualified_no_book',
                      'unqualified',
                      'abandoned'
                    )),
  handoff_triggered boolean default false,
  created_at        timestamptz default now()
);

create index if not exists idx_conversations_client_id  on conversations(client_id);
create index if not exists idx_conversations_started_at on conversations(started_at);
create index if not exists idx_conversations_outcome    on conversations(outcome);

-- ============================================================
-- APPOINTMENTS
-- ============================================================
create table if not exists appointments (
  id                   uuid primary key default gen_random_uuid(),
  conversation_id      uuid references conversations(id) on delete set null,
  client_id            uuid not null references clients(id) on delete cascade,
  action               text not null check (action in ('booked', 'rescheduled', 'cancelled')),
  appointment_datetime timestamptz,
  service_type         text,
  source               text,
  created_at           timestamptz default now()
);

create index if not exists idx_appointments_client_id  on appointments(client_id);
create index if not exists idx_appointments_action     on appointments(action);
create index if not exists idx_appointments_created_at on appointments(created_at);

-- ============================================================
-- MESSAGES
-- ============================================================
create table if not exists messages (
  id                        uuid primary key default gen_random_uuid(),
  conversation_id           uuid not null references conversations(id) on delete cascade,
  direction                 text not null check (direction in ('inbound', 'outbound')),
  sender_type               text not null check (sender_type in ('lead', 'bot', 'human_agent')),
  sent_at                   timestamptz default now(),
  message_length            int,
  is_qualification_question boolean default false
);

create index if not exists idx_messages_conversation_id on messages(conversation_id);
create index if not exists idx_messages_sent_at         on messages(sent_at);
create index if not exists idx_messages_sender_type     on messages(sender_type);

-- ============================================================
-- BOT EVENTS
-- ============================================================
create table if not exists bot_events (
  id              uuid primary key default gen_random_uuid(),
  client_id       uuid not null references clients(id) on delete cascade,
  conversation_id uuid references conversations(id) on delete set null,
  event_type      text not null check (event_type in (
                    'lead_qualified',
                    'follow_up_sent',
                    'no_show_recovered',
                    'out_of_hours_handled',
                    'objection_handled',
                    'reactivation_sent'
                  )),
  created_at      timestamptz default now(),
  metadata        jsonb default '{}'
);

create index if not exists idx_bot_events_client_id    on bot_events(client_id);
create index if not exists idx_bot_events_event_type   on bot_events(event_type);
create index if not exists idx_bot_events_created_at   on bot_events(created_at);

-- ============================================================
-- VIEWS
-- ============================================================
create or replace view client_summary as
select
  c.id,
  c.name,
  c.niche,
  count(distinct conv.id)                                                        as total_conversations,
  count(distinct m.id)                                                           as total_messages,
  count(distinct a.id)    filter (where a.action = 'booked')                    as appointments_booked,
  count(distinct a.id)    filter (where a.action = 'rescheduled')               as appointments_rescheduled,
  count(distinct a.id)    filter (where a.action = 'cancelled')                 as appointments_cancelled,
  count(distinct conv.id) filter (where conv.handoff_triggered)                 as handoffs,
  count(distinct be.id)   filter (where be.event_type = 'out_of_hours_handled') as out_of_hours,
  round(
    count(distinct conv.id) filter (where conv.outcome = 'appointment_booked')::numeric
    / nullif(count(distinct conv.id) filter (where conv.outcome is not null), 0) * 100,
    1
  ) as booking_rate_pct
from clients c
left join conversations conv on conv.client_id = c.id
left join messages m         on m.conversation_id = conv.id
left join appointments a     on a.client_id = c.id
left join bot_events be      on be.client_id = c.id
group by c.id, c.name, c.niche;

create or replace view monthly_activity as
select
  date_trunc('month', conv.started_at) as month,
  c.name                               as client,
  count(distinct conv.id)              as conversations,
  count(distinct m.id)                 as messages,
  count(distinct a.id) filter (where a.action = 'booked') as bookings
from conversations conv
join clients c  on c.id = conv.client_id
left join messages m     on m.conversation_id = conv.id
left join appointments a on a.conversation_id = conv.id
group by 1, 2
order by 1 desc, 3 desc;
