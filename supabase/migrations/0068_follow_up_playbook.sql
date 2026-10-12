-- ============================================================
-- Migration 0068 — the follow-up playbook: a ladder per stage
-- The Bot Crew · Agent Platform
--
-- 0067 records how far a lead got (NI / I / A / C). This release lets the ladder
-- READ it: tenant_config.follow_up_playbook picks the cadence, the angle pool and
-- the nudge's objective per stage — and per treatment (the persisted `interest`).
-- NULL playbook = the flat ladder, byte-identical to today.
--
-- Two stamps on follow_ups:
--   · stage       the stage the row was ARMED under. The rung shape follows the
--                 row (same rule as `round`, 0049): a stage that rises mid-cycle
--                 only does so on a lead message, which cancels the row anyway.
--   · angle_pool  which pool `angle_index` indexes into. Before 0068 there was one
--                 pool per conversation; with pools per stage the indexes collide,
--                 so "never repeat" becomes per pool. NULL = a legacy pool.
--
-- Expand/contract: the 5-arg app_schedule_follow_up is DROPPED and recreated with
-- p_stage DEFAULT NULL (keeping both would make a 5-arg call ambiguous — same
-- reason as 0063); the deployed Worker's 5-arg call still resolves. Same for
-- app_mark_follow_up_sent (+ p_angle_pool). app_load_due_follow_ups grows a
-- column, so DROP+CREATE as always.
-- ============================================================

ALTER TABLE public.tenant_config
  ADD COLUMN IF NOT EXISTS follow_up_playbook jsonb;

COMMENT ON COLUMN public.tenant_config.follow_up_playbook IS
  'Per-stage follow-up ladder (0068): {"stages":{"NI":{"cadence":[…],"objective":"…","angles":[…]},…},"byInterest":{"<service name>":{"NI":{…}}}}. NULL = flat ladder.';

ALTER TABLE public.follow_ups
  ADD COLUMN IF NOT EXISTS stage      text,
  ADD COLUMN IF NOT EXISTS angle_pool text;

ALTER TABLE public.follow_ups DROP CONSTRAINT IF EXISTS follow_ups_stage_check;
ALTER TABLE public.follow_ups ADD CONSTRAINT follow_ups_stage_check
  CHECK (stage IS NULL OR stage IN ('NI', 'I', 'A', 'C'));

-- ---------- app_schedule_follow_up: + p_stage ----------
DROP FUNCTION IF EXISTS public.app_schedule_follow_up(uuid, integer, timestamptz, text, integer);

CREATE FUNCTION public.app_schedule_follow_up(
  p_conversation_id uuid,
  p_tier            integer,
  p_scheduled_for   timestamptz,
  p_kind            text,
  p_round           integer,
  p_stage           text DEFAULT NULL
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

  INSERT INTO public.follow_ups (conversation_id, tier, status, scheduled_for, kind, round, stage)
  VALUES (p_conversation_id, p_tier, 'pending', p_scheduled_for,
          COALESCE(p_kind, 'cadence'), COALESCE(p_round, 0),
          CASE WHEN p_stage IN ('NI', 'I', 'A', 'C') THEN p_stage ELSE NULL END)
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

-- ---------- app_mark_follow_up_sent: + p_angle_pool ----------
DROP FUNCTION IF EXISTS public.app_mark_follow_up_sent(uuid, integer);

CREATE FUNCTION public.app_mark_follow_up_sent(
  p_follow_up_id uuid,
  p_angle_index  integer DEFAULT NULL::integer,
  p_angle_pool   text    DEFAULT NULL::text
) RETURNS void
LANGUAGE sql AS $$
  WITH marked AS (
    UPDATE public.follow_ups
    SET status = 'sent', sent_at = NOW(), angle_index = p_angle_index, angle_pool = p_angle_pool
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

-- ---------- app_load_due_follow_ups: + stage ----------
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
  round              integer,
  stage              text
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
      follow_ups.round           AS f_round,
      follow_ups.stage           AS f_stage
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
    cl.f_round,
    cl.f_stage
  FROM claimed cl
  JOIN public.conversations c ON c.id = cl.f_conv_id
  JOIN public.tenants t ON t.client_id = c.client_id;
$$;

-- Per 0032: revoke the default PUBLIC grant explicitly, grant service_role.
REVOKE ALL ON FUNCTION public.app_schedule_follow_up(uuid, integer, timestamptz, text, integer, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.app_mark_follow_up_sent(uuid, integer, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.app_load_due_follow_ups(integer) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.app_schedule_follow_up(uuid, integer, timestamptz, text, integer, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.app_mark_follow_up_sent(uuid, integer, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.app_load_due_follow_ups(integer) TO service_role;
