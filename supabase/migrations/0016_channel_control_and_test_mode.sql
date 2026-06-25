-- ============================================================
-- Migration 0016 — per-tenant channel control + test/demo mode
-- The Bot Crew · Agent Platform
--
-- enabled_channels: which channels the bot may REPLY on. NULL = none (installed
--   but silent — useful while onboarding/adjusting before going live).
--   We still STORE every inbound; this only gates whether the bot responds.
-- test_contact_ids: allowlist for pre-live testing. When non-empty, the bot
--   replies ONLY to these GHL contact ids, on ANY channel (bypasses the channel
--   gate). NULL/empty = normal behavior (channel gate applies).
-- ============================================================

ALTER TABLE public.tenant_config ADD COLUMN IF NOT EXISTS enabled_channels text[];
ALTER TABLE public.tenant_config ADD COLUMN IF NOT EXISTS test_contact_ids  text[];

-- Backfill existing tenants so live bots keep replying on all channels.
-- (New tenant_config rows are born NULL = silent until explicitly configured.)
UPDATE public.tenant_config
  SET enabled_channels = ARRAY['whatsapp', 'instagram', 'facebook']
  WHERE enabled_channels IS NULL;

-- Allow the new gating observability events in bot_events.
ALTER TABLE public.bot_events DROP CONSTRAINT IF EXISTS bot_events_event_type_check;
ALTER TABLE public.bot_events ADD CONSTRAINT bot_events_event_type_check
  CHECK (event_type = ANY (ARRAY[
    'lead_qualified', 'follow_up_sent', 'no_show_recovered', 'out_of_hours_handled',
    'objection_handled', 'reactivation_sent', 'agent_error', 'db_error', 'delivery_error',
    'run_superseded', 'run_suppressed', 'handoff_tag_on', 'handoff_tag_off',
    'channel_disabled', 'test_mode_skip'
  ]));
