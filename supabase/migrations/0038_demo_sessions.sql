-- ============================================================
-- Migration 0038 — demo sessions (lead-magnet self-demos)
-- The Bot Crew · Agent Platform
--
-- A lead who arrives from an ad gets a live demo of a bot FOR THEIR OWN
-- business, inside the Bot Crew's own tenant: the front-desk agent collects
-- 2-3 intake facts in-conversation and calls the startDemo tool, which creates
-- a demo_sessions row (generated persona + message budget + expiry) and flips
-- the conversation into the demo persona. When the budget is exhausted (or the
-- session expires) the conversation flips back to the tenant's NORMAL persona
-- — the closer — with a clean history start and a handoff context.
--
-- Distinct from the tenant-level demo keywords (0028): those are manual,
-- unlimited, operator-driven. Sessions are per-lead, budgeted, self-serve.
-- Both run on active_role='demo'; a session overlays its own generated persona
-- over demo_prompt_overrides at turn time.
--
-- ROLLBACK: additive (new table + nullable/default columns + RPC changes).
-- Old code ignores all of it. app_set_active_role: re-run the 0037 definition.
-- role_started_at is the EXPAND phase of generalizing demo_started_at — the
-- RPC writes both; code reads role_started_at with a demo_started_at fallback.
-- Drop demo_started_at only in a later release once this deploy is proven.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Feature flag (per tenant). false = startDemo refuses; nothing changes
--    for existing tenants.
-- ------------------------------------------------------------
ALTER TABLE public.tenant_config
  ADD COLUMN IF NOT EXISTS demo_sessions_enabled boolean NOT NULL DEFAULT false;

-- ------------------------------------------------------------
-- 2. role_started_at — when the CURRENT persona took over (demo start OR the
--    flip back to the closer). Generalizes demo_started_at, which only covered
--    entering demo, so the closer could never get its own clean start.
-- ------------------------------------------------------------
ALTER TABLE public.conversations ADD COLUMN IF NOT EXISTS role_started_at timestamptz;
UPDATE public.conversations SET role_started_at = demo_started_at WHERE demo_started_at IS NOT NULL;

-- On a persona TRANSITION, stamp role_started_at at the conversation's latest
-- INBOUND message (not now()): the message that caused the flip is already
-- logged, so stamping now() would exclude it and hand the new persona an empty
-- history. Stamping at the latest inbound keeps exactly that message in view.
-- demo_started_at keeps its 0037 semantics while old code may still read it.
CREATE OR REPLACE FUNCTION public.app_set_active_role(
  p_ghl_conversation_id text,
  p_active_role         text
) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_conv_id uuid;
  v_current text;
  v_anchor  timestamptz;
BEGIN
  SELECT id, active_role INTO v_conv_id, v_current
  FROM public.conversations WHERE ghl_conversation_id = p_ghl_conversation_id;
  IF v_conv_id IS NULL THEN RETURN; END IF;

  IF v_current IS DISTINCT FROM p_active_role THEN
    SELECT COALESCE(MAX(sent_at), now()) INTO v_anchor
    FROM public.messages
    WHERE conversation_id = v_conv_id AND direction = 'inbound';

    UPDATE public.conversations
    SET active_role     = p_active_role,
        role_started_at = v_anchor,
        demo_started_at = CASE WHEN p_active_role = 'demo' THEN v_anchor ELSE NULL END
    WHERE id = v_conv_id;
  END IF;
  -- Same role re-set: keep every stamp (the 0037 idempotency fix, extended).
END;
$$;

REVOKE ALL ON FUNCTION public.app_set_active_role(text, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.app_set_active_role(text, text) TO service_role;

-- ------------------------------------------------------------
-- 3. demo_sessions. One ACTIVE session per conversation (partial unique);
--    ended sessions stay as history. simulated_booking backs the demo's
--    fake booking flow (no GHL calls, no appointments rows).
-- ------------------------------------------------------------
CREATE TABLE public.demo_sessions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id           uuid NOT NULL REFERENCES public.clients(id),
  conversation_id     uuid NOT NULL REFERENCES public.conversations(id),
  ghl_conversation_id text NOT NULL,
  lead_data           jsonb NOT NULL DEFAULT '{}'::jsonb,
  prompt_overrides    jsonb NOT NULL,
  persona_version     int  NOT NULL DEFAULT 1,
  status              text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended')),
  end_reason          text CHECK (end_reason IN ('exhausted', 'expired', 'closed', 'replaced')),
  message_budget      int  NOT NULL DEFAULT 15,
  simulated_booking   jsonb,
  activated_at        timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz NOT NULL,
  ended_at            timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX demo_sessions_one_active
  ON public.demo_sessions (conversation_id) WHERE status = 'active';
CREATE INDEX demo_sessions_ghl_conv ON public.demo_sessions (ghl_conversation_id);

-- Repo convention: RLS on, zero policies = deny-by-default. The Worker's
-- service-role key bypasses it. (0032's default privileges already revoke
-- table grants from anon/authenticated for new tables.)
ALTER TABLE public.demo_sessions ENABLE ROW LEVEL SECURITY;

-- ------------------------------------------------------------
-- 4. RPCs. Create + end are ATOMIC with the persona flip — a session must
--    never exist without its conversation being in (or out of) demo mode.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.app_create_demo_session(
  p_ghl_conversation_id text,
  p_lead_data           jsonb,
  p_prompt_overrides    jsonb,
  p_message_budget      int,
  p_expires_minutes     int,
  p_persona_version     int DEFAULT 1
) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
  v_conv record;
  v_id   uuid;
BEGIN
  SELECT id, client_id INTO v_conv
  FROM public.conversations WHERE ghl_conversation_id = p_ghl_conversation_id;
  IF v_conv.id IS NULL THEN
    RAISE EXCEPTION 'unknown conversation %', p_ghl_conversation_id;
  END IF;

  -- A repeated startDemo replaces the running session (the lead asked for a
  -- fresh demo) instead of erroring into the agent's lap.
  UPDATE public.demo_sessions
  SET status = 'ended', end_reason = 'replaced', ended_at = now()
  WHERE conversation_id = v_conv.id AND status = 'active';

  INSERT INTO public.demo_sessions
    (client_id, conversation_id, ghl_conversation_id, lead_data, prompt_overrides,
     persona_version, message_budget, expires_at)
  VALUES
    (v_conv.client_id, v_conv.id, p_ghl_conversation_id, COALESCE(p_lead_data, '{}'::jsonb),
     p_prompt_overrides, COALESCE(p_persona_version, 1), COALESCE(p_message_budget, 15),
     now() + make_interval(mins => COALESCE(p_expires_minutes, 2880)))
  RETURNING id INTO v_id;

  PERFORM public.app_set_active_role(p_ghl_conversation_id, 'demo');
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.app_end_demo_session(
  p_session_id uuid,
  p_reason     text
) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_ghl_conv text;
BEGIN
  UPDATE public.demo_sessions
  SET status = 'ended', end_reason = p_reason, ended_at = now()
  WHERE id = p_session_id AND status = 'active'
  RETURNING ghl_conversation_id INTO v_ghl_conv;

  IF v_ghl_conv IS NOT NULL THEN
    -- Flip back to the normal persona (the closer). role_started_at lands on the
    -- latest inbound, so the closer sees the lead's last message and nothing of
    -- the roleplay.
    PERFORM public.app_set_active_role(v_ghl_conv, NULL);
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.app_create_demo_session(text, jsonb, jsonb, int, int, int) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.app_create_demo_session(text, jsonb, jsonb, int, int, int) TO service_role;
REVOKE ALL ON FUNCTION public.app_end_demo_session(uuid, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.app_end_demo_session(uuid, text) TO service_role;

-- ------------------------------------------------------------
-- 5. Observability.
-- ------------------------------------------------------------
ALTER TABLE public.bot_events DROP CONSTRAINT IF EXISTS bot_events_event_type_check;
ALTER TABLE public.bot_events ADD CONSTRAINT bot_events_event_type_check
  CHECK (event_type = ANY (ARRAY[
    'lead_qualified', 'follow_up_sent', 'no_show_recovered', 'out_of_hours_handled',
    'objection_handled', 'reactivation_sent', 'agent_error', 'db_error', 'delivery_error',
    'run_superseded', 'run_suppressed', 'handoff_tag_on', 'handoff_tag_off',
    'channel_disabled', 'test_mode_skip', 'keyword_required', 'bot_activated',
    'availability_checked', 'booking_failed', 'status_changed', 'turn_scheduled',
    'demo_toggled', 'ai_key_fallback', 'awaiting_human', 'variant_assigned',
    'demo_session_started', 'demo_session_ended'
  ]));
