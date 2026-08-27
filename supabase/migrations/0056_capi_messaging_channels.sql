-- ============================================================
-- Migration 0056 — Meta CAPI on Messenger and Instagram (extends 0048)
-- The Bot Crew · Agent Platform
--
-- 0048 signalled conversions for click-to-WhatsApp leads only: Meta attributes
-- those through the click id (`ctwa_clid`), and that was the only matching key
-- GHL was known to expose. Messenger and Instagram use different keys — the
-- page-scoped user id (PSID) and the Instagram-scoped id (IGSID) — and GHL
-- exposes both on the contact record too (verified 2026-08-26 on The Bot Crew's
-- own leads: `contact.attributionSource.pSid` on a Facebook lead,
-- `contact.attributionSource.igSid` on Instagram leads).
--
-- This adds ONE channel-agnostic column for whichever key the conversation's
-- channel needs. `ctwa_clid` stays and keeps being written for WhatsApp
-- (expand/contract: the deployed Worker still reads it) — drop it in a later
-- release once the 0056 Worker is proven.
--
-- The queue (`capi_events`) needs no change: the Meta `messaging_channel` is
-- frozen inside the payload jsonb next to user_data, and the drain treats a
-- payload without one as WhatsApp (every pre-0056 row).
--
-- tenant_config.meta_capi gains two optional ids (no schema change, jsonb):
--   "whatsapp_business_account_id"  — sent with ctwa_clid on WhatsApp events
--   "instagram_business_account_id" — REQUIRED for Instagram events (skipped without it)
-- Messenger events reuse the existing "page_id".
--
-- ROLLBACK: fully additive; the deployed Worker ignores the new column.
-- Apply BEFORE deploying the Worker that writes it.
-- ============================================================

ALTER TABLE public.conversations ADD COLUMN IF NOT EXISTS capi_match_key text;
COMMENT ON COLUMN public.conversations.capi_match_key IS
  'Meta CAPI matching key for this conversation''s channel (0056): ctwa_clid on WhatsApp, page-scoped user id (PSID) on Facebook/Messenger, Instagram-scoped id (IGSID) on Instagram. From GHL contact.attributionSource; first-touch sticky.';
COMMENT ON COLUMN public.conversations.ctwa_clid IS
  'Meta click-to-WhatsApp click id (from GHL contact.attributionSource). Superseded by capi_match_key (0056); still dual-written for WhatsApp — drop in a later release.';

COMMENT ON COLUMN public.tenant_config.meta_capi IS
  'Meta Conversions API config: {dataset_id, page_id, token_ref (secret slug), test_event_code?, whatsapp_business_account_id?, instagram_business_account_id?, events?}. NULL = off.';
