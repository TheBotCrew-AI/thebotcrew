-- ============================================================
-- Migration 0022 — follow-up quiet hours (DND)
-- The Bot Crew · Agent Platform
--
-- Follow-ups must never fire overnight. The Worker now computes the send time,
-- clamped out of the tenant's quiet window (default 21:00–08:00 local, overridable
-- per tenant via tenant_config.quiet_hours), and passes an absolute timestamp.
-- So app_schedule_follow_up takes p_scheduled_for instead of p_delay_minutes.
--
-- quiet_hours shape: {"start": 21, "end": 8} (local hours [0-23]). NULL = default.
-- ============================================================

ALTER TABLE public.tenant_config
  ADD COLUMN IF NOT EXISTS quiet_hours jsonb;

-- Old signature (uuid, int, int) is replaced by (uuid, int, timestamptz); drop it
-- explicitly since Postgres keys functions by argument types (CREATE OR REPLACE
-- with different types would create an overload rather than replace).
DROP FUNCTION IF EXISTS public.app_schedule_follow_up(uuid, int, int);

CREATE OR REPLACE FUNCTION public.app_schedule_follow_up(
  p_conversation_id uuid,
  p_tier            int,
  p_scheduled_for   timestamptz
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

  INSERT INTO public.follow_ups (conversation_id, tier, status, scheduled_for)
  VALUES (p_conversation_id, p_tier, 'pending', p_scheduled_for)
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;
