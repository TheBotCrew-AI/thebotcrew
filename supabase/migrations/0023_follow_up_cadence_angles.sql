-- ============================================================
-- Migration 0023 — decouple follow-up cadence from angles
-- The Bot Crew · Agent Platform
--
-- Follow-ups used to fuse timing + content into one "tier", so the cycle resetting
-- on every lead reply also reset the angle → the same angle repeated each cycle.
-- Now the two are independent:
--   • follow_up_cadence jsonb  — array of delays (minutes) per attempt in a cycle.
--     The cycle resets on every lead reply (fresh attempts); exhausting it with no
--     reply stops (standby). This is the timing/attempt dimension.
--   • follow_up_angles jsonb   — pool of angle directives, decoupled from timing.
--     A per-conversation cursor (follow_ups.angle_index on SENT rows) advances across
--     the whole conversation and never resets, so angles don't repeat between cycles.
--
-- follow_up_tiers is kept (unread) for rollback safety.
-- ============================================================

ALTER TABLE public.tenant_config
  ADD COLUMN IF NOT EXISTS follow_up_cadence jsonb,
  ADD COLUMN IF NOT EXISTS follow_up_angles  jsonb;

-- Which pool angle a SENT follow-up used (NULL = free-formed after the pool ran out).
-- Cursor of "used" angles is: SELECT angle_index FROM follow_ups WHERE status='sent'.
ALTER TABLE public.follow_ups
  ADD COLUMN IF NOT EXISTS angle_index int;

-- Backfill: split every tenant's existing tiers into ordered cadence + angles.
UPDATE public.tenant_config
SET follow_up_cadence = (
      SELECT jsonb_agg((t->>'delayMinutes')::int ORDER BY (t->>'tier')::int)
      FROM jsonb_array_elements(follow_up_tiers) AS t
    ),
    follow_up_angles = (
      SELECT jsonb_agg(t->'angle' ORDER BY (t->>'tier')::int)
      FROM jsonb_array_elements(follow_up_tiers) AS t
    )
WHERE follow_up_tiers IS NOT NULL
  AND jsonb_typeof(follow_up_tiers) = 'array';

-- Record the chosen angle when marking a follow-up sent. Nullable + defaulted so
-- existing callers keep working.
DROP FUNCTION IF EXISTS public.app_mark_follow_up_sent(uuid);
CREATE OR REPLACE FUNCTION public.app_mark_follow_up_sent(
  p_follow_up_id uuid,
  p_angle_index  int DEFAULT NULL
) RETURNS void
LANGUAGE sql AS $$
  UPDATE public.follow_ups
  SET status = 'sent', sent_at = NOW(), angle_index = p_angle_index
  WHERE id = p_follow_up_id;
$$;
