-- ============================================================
-- Migration 0014 — atomic follow-up claiming (prevent double-send)
-- The Bot Crew · Agent Platform
--
-- Problem: cron fires every minute; waitUntil lets invocations overlap.
-- Two workers both read the same 'pending' follow-up and process it,
-- producing duplicate messages and duplicate next-tier rows.
--
-- Fix: add a 'processing' status and rewrite app_load_due_follow_ups
-- to atomically UPDATE rows to 'processing' before returning them
-- (using FOR UPDATE SKIP LOCKED). The second worker skips locked rows
-- and never processes the same follow-up twice.
-- ============================================================

-- ── Add 'processing' to the allowed status values ────────────────────────────

ALTER TABLE public.follow_ups
  DROP CONSTRAINT IF EXISTS follow_ups_status_check;

ALTER TABLE public.follow_ups
  ADD CONSTRAINT follow_ups_status_check
  CHECK (status IN ('pending', 'processing', 'sent', 'cancelled', 'failed'));

-- ── Rewrite app_load_due_follow_ups — atomic claim ───────────────────────────
-- Uses a CTE with UPDATE...RETURNING so the lock + status change happen in a
-- single statement. FOR UPDATE SKIP LOCKED ensures concurrent callers never
-- claim the same row.

-- LANGUAGE sql avoids the plpgsql variable/column name ambiguity on
-- 'conversation_id' (return column vs table column in RETURNING clause).
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
      follow_ups.id              AS f_id,
      follow_ups.conversation_id AS f_conv_id,
      follow_ups.tier            AS f_tier
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

-- ── Also cancel 'processing' rows when the lead replies ──────────────────────
-- Without this, a follow-up being processed while the lead messages would
-- survive cancelFollowUps and still send.

CREATE OR REPLACE FUNCTION public.app_cancel_follow_ups(
  p_conversation_id uuid
) RETURNS void
LANGUAGE sql AS $$
  UPDATE public.follow_ups
  SET status = 'cancelled'
  WHERE conversation_id = p_conversation_id
    AND status IN ('pending', 'processing');
$$;
