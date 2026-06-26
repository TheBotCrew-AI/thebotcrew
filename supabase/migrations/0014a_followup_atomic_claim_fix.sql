-- ============================================================
-- Migration 0014a — followup atomic-claim fix
-- The Bot Crew · Agent Platform
--
-- Backfilled from remote (version 20260613200334). Captures a change that
-- had been applied directly to production but was missing from the repo.
-- ============================================================

-- Fix: rewrite in LANGUAGE sql to avoid plpgsql variable/column name ambiguity.
-- Data-modifying CTEs work fine in SQL functions on PG 17.

CREATE OR REPLACE FUNCTION public.app_load_due_follow_ups(
  p_limit int DEFAULT 20
) RETURNS TABLE (
  follow_up_id        uuid,
  conversation_id     uuid,
  ghl_conversation_id text,
  ghl_contact_id      text,
  contact_phone       text,
  channel             text,
  tier                int,
  ghl_location_id     text
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
      follow_ups.id           AS f_id,
      follow_ups.conversation_id AS f_conv_id,
      follow_ups.tier         AS f_tier
  )
  SELECT
    cl.f_id,
    cl.f_conv_id,
    c.ghl_conversation_id,
    c.ghl_contact_id,
    c.contact_phone,
    c.channel,
    cl.f_tier,
    t.ghl_location_id
  FROM claimed cl
  JOIN public.conversations c ON c.id = cl.f_conv_id
  JOIN public.tenants t ON t.client_id = c.client_id;
$$;
