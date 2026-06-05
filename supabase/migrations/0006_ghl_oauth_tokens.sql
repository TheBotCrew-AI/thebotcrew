-- ============================================================
-- Migration 0006 — GHL OAuth2 tokens (App Marketplace)
-- The Bot Crew · Agent Platform
--
-- Stores per-tenant access + refresh tokens obtained via the GHL App
-- Marketplace OAuth2 flow. One row per tenant; upserted on every install
-- or token refresh. The Worker reads this table (service-role) to get the
-- right token for each tenant before any outbound GHL API call.
--
-- Also drops the old ghl_token_ref placeholder on tenants (replaced by this
-- table's tenant_id FK).
-- ============================================================

create table if not exists ghl_oauth_tokens (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null unique references tenants(id) on delete cascade,
  access_token  text not null,
  refresh_token text not null,
  expires_at    timestamptz not null,
  token_type    text not null default 'Bearer',
  scope         text,
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);

-- RLS: deny-by-default. Worker uses service_role which bypasses RLS.
alter table ghl_oauth_tokens enable row level security;

-- Drop the old placeholder column, superseded by ghl_oauth_tokens.
alter table tenants drop column if exists ghl_token_ref;
