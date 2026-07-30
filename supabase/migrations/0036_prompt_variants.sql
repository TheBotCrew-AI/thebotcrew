-- ============================================================
-- Migration 0036 — prompt variants (per-campaign prompts, n:1 keyword mapping)
-- The Bot Crew · Agent Platform
--
-- One tenant, several ad campaigns, one prompt each — without a monolithic
-- prompt. Two per-tenant jsonb configs:
--
--   keyword_variants : { "promo laser": "laser-promo", ... }
--       inbound keyword → variant key. Several keywords may point to the same
--       variant (n:1). Matching reuses the trigger-keyword normalizer
--       (whole-word, case- & accent-insensitive); the LONGEST matching keyword
--       wins when a message matches several.
--   prompt_variants  : { "laser-promo": { offering: "...", ... }, ... }
--       variant key → partial prompt overrides (same shape as prompt_overrides).
--       At prompt-build time the variant MERGES field-by-field over the base
--       prompt_overrides — tone/hours/services/FAQ stay single-sourced.
--
-- Orthogonal to the trigger-keyword GATE (0017): trigger_keywords decides IF the
-- bot enters; keyword_variants decides WHICH persona flavors the thread. A
-- tenant may use either or both (listing a keyword in both if gated).
--
-- Assignment is FIRST-TOUCH STICKY, enforced in SQL (COALESCE): the first
-- matching message pins conversations.prompt_variant; later campaign keywords
-- never switch it (ad-attribution semantics; no mid-thread personality swap).
--
-- ROLLBACK: fully additive. Old code ignores every new column; to revert,
-- deploy the previous Worker version — no schema rollback needed. (Dropping the
-- columns/RPC is safe once no deployed version references them.)
-- ============================================================

-- Per-tenant config (NULL = feature off; every existing tenant unaffected).
ALTER TABLE public.tenant_config ADD COLUMN IF NOT EXISTS keyword_variants jsonb;
ALTER TABLE public.tenant_config ADD COLUMN IF NOT EXISTS prompt_variants  jsonb;

-- Per-conversation assignment (NULL = base prompt; set once, first touch).
ALTER TABLE public.conversations ADD COLUMN IF NOT EXISTS prompt_variant text;

-- First-touch sticky assignment. Returns true only when THIS call pinned the
-- variant (callers log the variant_assigned event only then). COALESCE makes
-- re-matches no-ops, so the handler can call it without a prior read.
CREATE OR REPLACE FUNCTION public.app_set_prompt_variant(
  p_ghl_conversation_id text,
  p_variant             text
) RETURNS boolean
LANGUAGE plpgsql AS $$
DECLARE
  v_assigned boolean := false;
BEGIN
  UPDATE public.conversations
  SET prompt_variant = COALESCE(prompt_variant, p_variant)
  WHERE ghl_conversation_id = p_ghl_conversation_id
    AND prompt_variant IS NULL
    AND p_variant IS NOT NULL;
  v_assigned := FOUND;
  RETURN v_assigned;
END;
$$;

-- Per 0032: new functions are born with EXECUTE granted to PUBLIC — revoke it
-- explicitly (revoking from anon alone is a no-op) and grant service_role.
REVOKE ALL ON FUNCTION public.app_set_prompt_variant(text, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.app_set_prompt_variant(text, text) TO service_role;

-- Observability: which campaign each conversation entered through.
-- `known:false` in the payload is the misconfiguration fingerprint (a keyword
-- mapped to a variant key that has no prompt_variants entry — the prompt falls
-- back to base, loudly, never silently).
ALTER TABLE public.bot_events DROP CONSTRAINT IF EXISTS bot_events_event_type_check;
ALTER TABLE public.bot_events ADD CONSTRAINT bot_events_event_type_check
  CHECK (event_type = ANY (ARRAY[
    'lead_qualified', 'follow_up_sent', 'no_show_recovered', 'out_of_hours_handled',
    'objection_handled', 'reactivation_sent', 'agent_error', 'db_error', 'delivery_error',
    'run_superseded', 'run_suppressed', 'handoff_tag_on', 'handoff_tag_off',
    'channel_disabled', 'test_mode_skip', 'keyword_required', 'bot_activated',
    'availability_checked', 'booking_failed', 'status_changed', 'turn_scheduled',
    'demo_toggled', 'ai_key_fallback', 'awaiting_human', 'variant_assigned'
  ]));
