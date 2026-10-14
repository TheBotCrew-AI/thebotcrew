-- ============================================================
-- Migration 0072 — campaign variants: re-pin by keyword + expiry by silence
-- The Bot Crew · Agent Platform
--
-- A recovery campaign (a WhatsApp template to leads who asked about a treatment
-- months ago) needs two things first-touch sticky (0036) refuses:
--
--   1. The thread must SWITCH scripts. The lead is pinned to the ad campaign they
--      came from (Heriberto: ~200 threads on a01–a06, the September jornada), and
--      the COALESCE in app_set_prompt_variant never lets a later keyword replace
--      it. A variant marked `repin: true` in prompt_variants now may: the Worker
--      calls app_set_prompt_variant with p_force = true for those, and only those.
--      A re-pin also resets reactivation_round — a recovery is a new nudge cycle,
--      not the tail of the old one.
--
--   2. A pin must not outlive the campaign. A lead who writes back after months
--      of silence should get the base prompt, not a dead promotion. Per tenant,
--      tenant_config.variant_ttl_days (NULL = never, today's behavior): when the
--      latest inbound BEFORE the current one is older than that, the pin is
--      cleared before the keyword match runs — so a recovery keyword on an
--      expired thread pins the ordinary way, no force needed.
--
-- app_set_prompt_variant(text, text) is DROPPED and replaced by the 3-arg form with
-- p_force DEFAULT false: keeping both would be ambiguous for a named call with two
-- arguments (same reason as 0063). The deployed Worker calls it with two names and
-- keeps working — migration FIRST, Worker after.
--
-- ROLLBACK: additive apart from that overload swap. Old code ignores the column;
-- redeploying the previous Worker is enough.
-- ============================================================

ALTER TABLE public.tenant_config
  ADD COLUMN IF NOT EXISTS variant_ttl_days integer
  CHECK (variant_ttl_days IS NULL OR variant_ttl_days > 0);

COMMENT ON COLUMN public.tenant_config.variant_ttl_days IS
  'Days of lead silence after which a pinned prompt_variant is cleared on the next inbound (0072). NULL = a pin never expires.';

-- ── Re-pin ───────────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.app_set_prompt_variant(text, text);

-- Returns true when THIS call changed the pin (first touch, or a forced switch to a
-- DIFFERENT variant). A forced call that lands on the variant already pinned is a
-- no-op (false): a lead who types the recovery keyword twice must not reset their
-- round counter twice.
CREATE OR REPLACE FUNCTION public.app_set_prompt_variant(
  p_ghl_conversation_id text,
  p_variant             text,
  p_force               boolean DEFAULT false
) RETURNS boolean
LANGUAGE plpgsql AS $$
BEGIN
  IF p_variant IS NULL THEN
    RETURN false;
  END IF;
  IF p_force THEN
    UPDATE public.conversations
    SET prompt_variant     = p_variant,
        reactivation_round = CASE WHEN prompt_variant IS NULL THEN reactivation_round ELSE 0 END
    WHERE ghl_conversation_id = p_ghl_conversation_id
      AND prompt_variant IS DISTINCT FROM p_variant;
  ELSE
    UPDATE public.conversations
    SET prompt_variant = p_variant
    WHERE ghl_conversation_id = p_ghl_conversation_id
      AND prompt_variant IS NULL;
  END IF;
  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.app_set_prompt_variant(text, text, boolean) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.app_set_prompt_variant(text, text, boolean) TO service_role;

-- ── Expiry ───────────────────────────────────────────────────────────────────
-- Called once per inbound, BEFORE the keyword match, with the id of the message just
-- logged. Measures silence as the gap to the latest inbound that is not this one — a
-- burst of two messages from the lead counts once, and the bot's own nudges never
-- keep a pin alive. Returns the variant it cleared, or NULL when nothing expired
-- (no pin, no TTL, no previous inbound, or a recent one).
CREATE OR REPLACE FUNCTION public.app_expire_prompt_variant(
  p_conversation_id uuid,
  p_message_id      uuid,
  p_ttl_days        integer
) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_variant   text;
  v_last_seen timestamptz;
BEGIN
  IF p_ttl_days IS NULL OR p_ttl_days <= 0 THEN
    RETURN NULL;
  END IF;
  SELECT prompt_variant INTO v_variant
  FROM public.conversations WHERE id = p_conversation_id FOR UPDATE;
  IF v_variant IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT max(sent_at) INTO v_last_seen FROM public.messages
  WHERE conversation_id = p_conversation_id
    AND direction = 'inbound'
    AND id IS DISTINCT FROM p_message_id;
  IF v_last_seen IS NULL OR v_last_seen >= now() - make_interval(days => p_ttl_days) THEN
    RETURN NULL;
  END IF;
  UPDATE public.conversations SET prompt_variant = NULL WHERE id = p_conversation_id;
  RETURN v_variant;
END;
$$;

REVOKE ALL ON FUNCTION public.app_expire_prompt_variant(uuid, uuid, integer) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.app_expire_prompt_variant(uuid, uuid, integer) TO service_role;

-- ── A campaign send in the store ─────────────────────────────────────────────
-- The outbound webhook now keeps a bulk send (source 'bulk_actions', no userId) as
-- sender_type = 'campaign': the business's words, but nobody's reply — so it is marked
-- for the model as the offer on the table, never counted as a human answer (0054's
-- pending_info resolution looks for 'human_agent' only), and opens no human pause.
ALTER TABLE public.messages DROP CONSTRAINT IF EXISTS messages_sender_type_check;
ALTER TABLE public.messages ADD CONSTRAINT messages_sender_type_check
  CHECK (sender_type = ANY (ARRAY['lead', 'bot', 'human_agent', 'campaign']));

-- ── Event ────────────────────────────────────────────────────────────────────
-- variant_expired: {variant, ttlDays} — the pin was cleared for silence. A re-pin
-- rides on the existing variant_assigned event as {repinned:true, previous}.
ALTER TABLE public.bot_events DROP CONSTRAINT IF EXISTS bot_events_event_type_check;
ALTER TABLE public.bot_events ADD CONSTRAINT bot_events_event_type_check
  CHECK (event_type = ANY (ARRAY[
    'lead_qualified', 'follow_up_sent', 'no_show_recovered', 'out_of_hours_handled',
    'objection_handled', 'reactivation_sent', 'agent_error', 'db_error', 'delivery_error',
    'run_superseded', 'run_suppressed', 'handoff_tag_on', 'handoff_tag_off',
    'channel_disabled', 'test_mode_skip', 'keyword_required', 'bot_activated',
    'availability_checked', 'booking_failed', 'status_changed', 'turn_scheduled',
    'demo_toggled', 'ai_key_fallback', 'awaiting_human', 'variant_assigned',
    'demo_session_started', 'demo_session_ended', 'lead_disqualified',
    'followup_aborted', 'demo_reminder_sent', 'status_change_blocked',
    'attachment_received', 'attachment_failed',
    'capi_event_sent', 'capi_error',
    'reactivation_exhausted', 'pending_info',
    'resume_skipped',
    'pending_info_escalated', 'info_gap_error',
    'interest_tagged',
    'turn_answered',
    'hold_created', 'hold_released', 'hold_expired', 'booking_paid', 'booking_paid_late',
    'payment_error', 'hold_reminder_sent',
    'prime_time_released',
    'stage_changed',
    'courtesy_skipped',
    'variant_expired'
  ]));
