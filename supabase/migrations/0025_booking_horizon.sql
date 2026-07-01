-- ============================================================
-- Migration 0025 — per-tenant booking horizon
-- The Bot Crew · Agent Platform
--
-- Business rule: the bot must not look for / offer appointment slots past a certain
-- date. Enforced DETERMINISTICALLY in the getAvailability tool (not left to the model):
-- the requested range is clamped to now + booking_horizon_days, and a range entirely
-- beyond it returns an out-of-window note the agent relays to the lead.
--
-- booking_horizon_days: max days ahead. NULL = no cap (current behavior).
-- ============================================================

ALTER TABLE public.tenant_config
  ADD COLUMN IF NOT EXISTS booking_horizon_days int;
