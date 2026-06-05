-- ============================================================
-- Migration 0004 — tenant config (agent runtime read-layer)
-- The Bot Crew · Agent Platform
--
-- Adds the per-tenant config the front-desk agent reads at runtime.
-- This is the READ layer; the existing stats tables remain the WRITE/proof layer.
-- The Worker resolves a tenant from the GHL location (subaccount) id.
-- ============================================================

-- ------------------------------------------------------------
-- TENANTS — maps a GHL subaccount/location to one of our clients
-- ------------------------------------------------------------
create table if not exists tenants (
  id              uuid primary key default gen_random_uuid(),
  client_id       uuid not null references clients(id) on delete cascade,
  ghl_location_id text not null unique,   -- subaccount id from the inbound webhook
  ghl_token_ref   text,                    -- NAME/reference of a secret, never the token
  is_active       boolean default true,
  created_at      timestamptz default now()
);

create index if not exists idx_tenants_client_id on tenants(client_id);

-- ------------------------------------------------------------
-- TENANT_CONFIG — the variables that fill the prompt template + tools
-- ------------------------------------------------------------
create table if not exists tenant_config (
  tenant_id        uuid primary key references tenants(id) on delete cascade,
  business_name    text not null,
  timezone         text not null default 'America/Mexico_City',
  tone             text,                          -- optional tone override
  services         jsonb not null default '[]',   -- [{ name, durationMin?, description? }]
  hours            jsonb not null default '{}',   -- { mon: [{ open, close }], ... }
  calendars        jsonb not null default '{}',   -- { serviceName: ghl_calendar_id }
  faq              jsonb not null default '[]',   -- [{ q, a }]
  enabled_roles    text[] not null default '{front-desk}',
  prompt_overrides jsonb default '{}',            -- optional per-tenant prompt tweaks
  updated_at       timestamptz default now()
);

-- ------------------------------------------------------------
-- RLS — deny-by-default. The Worker uses the service_role key, which BYPASSES RLS.
-- No anon/authenticated policies yet; the dashboard gets explicit read policies later.
-- ------------------------------------------------------------
alter table tenants       enable row level security;
alter table tenant_config enable row level security;
