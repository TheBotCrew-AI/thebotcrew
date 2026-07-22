-- ============================================================
-- Migration 0031 — store contact email for merge recovery
-- The Bot Crew · Agent Platform
--
-- GHL dedups contacts by phone OR email and can merge away the contactId a webhook
-- gave us, breaking sends with CONVERSATIONS_CONTACT_NOT_FOUND. Recovery re-resolves the
-- surviving contact by searching those same keys. We already keep `contact_phone`; add
-- `contact_email` so an email-only lead (no phone) is recoverable too. Captured from the
-- live contact at inbound/turn time (see webhook-handler) while the contact still exists.
-- ============================================================

ALTER TABLE public.conversations ADD COLUMN IF NOT EXISTS contact_email text;
