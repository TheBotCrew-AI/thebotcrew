-- ============================================================
-- Migration 0007 — per-tenant AI provider + model config
-- The Bot Crew · Agent Platform
--
-- Adds ai_provider and ai_model to tenant_config so each tenant
-- can use a different model/provider. NULL means use the platform
-- default resolved from env (OPENAI_API_KEY / ANTHROPIC_API_KEY).
-- ============================================================

alter table tenant_config
  add column if not exists ai_provider text,   -- 'openai' | 'anthropic' | null = platform default
  add column if not exists ai_model    text;   -- e.g. 'gpt-4o-mini' | null = platform default
