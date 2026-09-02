-- ============================================================
-- Migration 0059 — per-tenant minimum booking notice
-- The Bot Crew · Agent Platform
--
-- Business rule: the bot must not offer or book same-day appointments (Dr. Valdivia,
-- 2026-09-02: "solo a partir de mañana"). The near-side twin of booking_horizon_days
-- (0025), enforced DETERMINISTICALLY in the tools, never left to the model:
--   - getAvailability lifts the queried range to local midnight of today + N in the
--     tenant timezone (a range ending before that returns a `too_soon` note),
--   - bookAppointment / rescheduleAppointment refuse a resolved slot before that instant
--     (`booking_failed` reason `too_soon`), even if GHL has it free,
--   - the prompt states the first bookable day as a pre-computed date.
--
-- booking_min_notice_days: calendar days of notice. 1 = never today, first slot from
-- tomorrow 00:00 local. NULL = same-day allowed (current behavior for every tenant).
-- Expand/contract: nullable, read by the Worker only after it ships; set per tenant after.
-- ============================================================

ALTER TABLE public.tenant_config
  ADD COLUMN IF NOT EXISTS booking_min_notice_days int
  CHECK (booking_min_notice_days IS NULL OR booking_min_notice_days > 0);

COMMENT ON COLUMN public.tenant_config.booking_min_notice_days IS
  'Min calendar days of notice before the bot offers/books a slot (1 = never today; first slot from local midnight of tomorrow). NULL = same-day allowed.';
