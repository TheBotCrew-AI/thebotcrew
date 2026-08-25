-- ============================================================
-- Migration 0052 — per-tenant human-takeover pause window
-- The Bot Crew · Agent Platform
--
-- Business rule: when a human agent replies in GHL, the bot pauses (sliding
-- window, app_set_human_active). The window was a hardcoded 5 minutes for every
-- tenant; MADI's team works threads for longer than that, so the bot re-entered
-- conversations a human was still handling (the window expired seconds before
-- the lead's next message scheduled a turn).
--
-- human_pause_minutes: sliding-pause length in minutes. NULL = platform
-- default (5). Enforced in the Worker (outbound-handler passes it to
-- app_set_human_active, which already takes p_minutes) — no RPC change.
-- ============================================================

ALTER TABLE public.tenant_config
  ADD COLUMN IF NOT EXISTS human_pause_minutes int;
