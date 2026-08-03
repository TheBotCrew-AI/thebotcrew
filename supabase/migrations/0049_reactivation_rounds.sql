-- ============================================================
-- Migration 0049 — reactivation rounds: front-load + taper + stop
-- The Bot Crew · Agent Platform
--
-- THE HOLE. The follow-up ladder is effectively infinite: exhausting the
-- cadence parks the conversation in 'standby' (the freno), but the lead's next
-- inbound reactivates it and the bot's reply re-arms the FULL cadence — every
-- time, forever. A lead who ghosts, resurfaces, and ghosts again gets the same
-- heavy pursuit on every cycle, with the finite angle pool as the only brake.
--
-- THE MODEL. Each ghost→pursuit cycle is a "round". Round 0 runs the tenant's
-- own follow_up_cadence (unchanged). Rounds 1+ run shorter, softer cadences
-- (platform default [[360,1080],[960]], per-tenant override in
-- tenant_config.follow_up_rounds). After the last round the lead is never
-- pursued again — the bot still answers if they write; only the nudges stop.
-- No new conversation status: the gate is the counter, read at arming time.
--
-- WHEN A ROUND IS CONSUMED. Only when the FIRST nudge of a cycle actually
-- lands: app_mark_follow_up_sent bumps conversations.reactivation_round for a
-- kind='cadence' tier-1 row. A lead who replies before any nudge fires burns
-- nothing — position 1 is armed after EVERY bot reply and cancelled on every
-- inbound, so anything else would punish an actively-conversing lead.
-- Each follow_ups row is stamped with its round at scheduling time, so
-- mid-cycle rung progression keeps its shape even after the counter moves.
-- A successful (real, non-demo) booking resets the counter to 0
-- (app_reset_reactivation_round): during the booked period the appointment
-- gate keeps all nudges off anyway, so the reset only takes effect once the
-- last appointment has passed — a returning customer starts fresh.
--
-- EXPAND/CONTRACT. Everything here is backward-compatible with the currently
-- deployed Worker; apply BEFORE the deploy.
--   · New columns are defaulted; in-flight rows scheduled by the old Worker
--     read round=0 — the behaviour they were scheduled under (the `kind`
--     precedent from 0043).
--   · `app_load_due_follow_ups` is DROP+CREATE (RETURNS TABLE grows a column;
--     Postgres refuses REPLACE). The old Worker maps by name — inert.
--   · `app_mark_follow_up_sent` keeps its signature; during the
--     migration→deploy window the old Worker's tier-1 sends bump counters it
--     never reads. Harmless: no gate exists until the deploy, and GREATEST
--     keeps a stale row from ever regressing the counter.
--   · CONTRACT folded in from 0043's header: the 3-arg app_schedule_follow_up
--     (0012) is dropped — the Worker has called the 4-arg named form since the
--     0043 deploy, five releases ago.
--   · CONTRACT (later release, once THIS deploy is proven): drop the 4-arg
--     app_schedule_follow_up overload.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Schema.
-- ------------------------------------------------------------
ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS reactivation_round int NOT NULL DEFAULT 0;

ALTER TABLE public.follow_ups
  ADD COLUMN IF NOT EXISTS round int NOT NULL DEFAULT 0;

-- Cadences for rounds 1+ as an array of arrays of minutes, e.g. [[360,1080],[960]].
-- NULL = platform default taper; [] = no extra rounds (round 0 only).
-- Round 0 always comes from follow_up_cadence. (tenant_config_history's trigger
-- snapshots full rows as jsonb — no change needed there.)
ALTER TABLE public.tenant_config
  ADD COLUMN IF NOT EXISTS follow_up_rounds jsonb;

-- ------------------------------------------------------------
-- 2. Scheduling with a round. NEW 5-arg overload; the 4-arg version stays for
--    the deployed Worker. The 0012 3-arg overload goes now (see header).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.app_schedule_follow_up(
  p_conversation_id uuid,
  p_tier            integer,
  p_scheduled_for   timestamptz,
  p_kind            text,
  p_round           integer
) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
  v_status text;
  v_id     uuid;
BEGIN
  SELECT status INTO v_status FROM public.conversations WHERE id = p_conversation_id;
  IF v_status IS DISTINCT FROM 'active' THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.follow_ups (conversation_id, tier, status, scheduled_for, kind, round)
  VALUES (p_conversation_id, p_tier, 'pending', p_scheduled_for,
          COALESCE(p_kind, 'cadence'), COALESCE(p_round, 0))
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

DROP FUNCTION IF EXISTS public.app_schedule_follow_up(uuid, integer, timestamptz);

-- ------------------------------------------------------------
-- 3. Due-row claim — also hands back the row's round so the runner resolves the
--    cadence shape the row was scheduled under, not whatever the counter says now.
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS public.app_load_due_follow_ups(integer);
CREATE FUNCTION public.app_load_due_follow_ups(p_limit integer DEFAULT 20)
RETURNS TABLE(
  follow_up_id       uuid,
  conversation_id    uuid,
  ghl_conversation_id text,
  ghl_contact_id     text,
  contact_phone      text,
  channel            text,
  tier               integer,
  ghl_location_id    text,
  kind               text,
  last_inbound_message_id uuid,
  round              integer
)
LANGUAGE sql AS $$
  WITH claimed AS (
    UPDATE public.follow_ups
    SET status = 'processing'
    WHERE id IN (
      SELECT fu.id
      FROM public.follow_ups fu
      JOIN public.conversations c ON c.id = fu.conversation_id
      WHERE fu.status = 'pending'
        AND fu.scheduled_for <= NOW()
        AND c.status = 'active'
      ORDER BY fu.scheduled_for
      LIMIT p_limit
      FOR UPDATE OF fu SKIP LOCKED
    )
    RETURNING
      follow_ups.id              AS f_id,
      follow_ups.conversation_id AS f_conv_id,
      follow_ups.tier            AS f_tier,
      follow_ups.kind            AS f_kind,
      follow_ups.round           AS f_round
  )
  SELECT
    cl.f_id,
    cl.f_conv_id,
    c.ghl_conversation_id,
    c.ghl_contact_id,
    c.contact_phone,
    c.channel,
    cl.f_tier,
    t.ghl_location_id,
    cl.f_kind,
    c.last_inbound_message_id,
    cl.f_round
  FROM claimed cl
  JOIN public.conversations c ON c.id = cl.f_conv_id
  JOIN public.tenants t ON t.client_id = c.client_id;
$$;

-- ------------------------------------------------------------
-- 4. The round is CONSUMED here — when the first nudge of a cycle actually
--    lands. Still requires 'sending' (the 0043 gate); a cancelled or aborted
--    row can neither be marked sent nor burn a round. GREATEST because a stale
--    row (scheduled before the counter advanced) must never regress it.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.app_mark_follow_up_sent(
  p_follow_up_id uuid,
  p_angle_index  integer DEFAULT NULL::integer
) RETURNS void
LANGUAGE sql AS $$
  WITH marked AS (
    UPDATE public.follow_ups
    SET status = 'sent', sent_at = NOW(), angle_index = p_angle_index
    WHERE id = p_follow_up_id
      AND status = 'sending'
    RETURNING conversation_id, kind, tier, round
  )
  UPDATE public.conversations c
  SET reactivation_round = GREATEST(c.reactivation_round, m.round + 1)
  FROM marked m
  WHERE c.id = m.conversation_id
    AND m.kind = 'cadence'
    AND m.tier = 1;
$$;

-- ------------------------------------------------------------
-- 5. Reset on conversion. Called (fire-and-forget) by the booking tool on a
--    real, non-demo booking: the pursuit worked, so the ghost history is wiped
--    and — once the booked period is over — a future silence starts at round 0.
--    Keyed by ghl_conversation_id like app_update_conversation_status.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.app_reset_reactivation_round(p_ghl_conversation_id text)
RETURNS void
LANGUAGE sql AS $$
  UPDATE public.conversations
  SET reactivation_round = 0
  WHERE ghl_conversation_id = p_ghl_conversation_id
    AND reactivation_round <> 0;
$$;

-- ------------------------------------------------------------
-- 6. Observability: `reactivation_exhausted` marks the end of the last round —
--    the lead got every tapered pursuit they will ever get. (The runner also
--    writes the `reactivacion-agotada` GHL tag; aborts for an upcoming
--    appointment reuse `followup_aborted` with a payload reason, no new type.)
--    List = 0048's (the latest) + the new value.
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
    'demo_session_started', 'demo_session_ended', 'lead_disqualified',
    'followup_aborted', 'demo_reminder_sent', 'status_change_blocked',
    'attachment_received', 'attachment_failed',
    'capi_event_sent', 'capi_error',
    'reactivation_exhausted'
  ]));

-- ------------------------------------------------------------
-- 7. Grants — every new/replaced signature, per the 0032 rule.
-- ------------------------------------------------------------
REVOKE ALL ON FUNCTION public.app_schedule_follow_up(uuid, integer, timestamptz, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.app_load_due_follow_ups(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.app_mark_follow_up_sent(uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.app_reset_reactivation_round(text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.app_schedule_follow_up(uuid, integer, timestamptz, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.app_load_due_follow_ups(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.app_mark_follow_up_sent(uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.app_reset_reactivation_round(text) TO service_role;
