-- ============================================================
-- Migration 0020 — turn reconciliation (durability net)
-- The Bot Crew · Agent Platform
--
-- The 8s debounce is a setTimeout in waitUntil; an isolate eviction or a
-- transient model/GHL failure silently drops the turn (no reply). This adds a
-- reconciliation sweep: a cron finds conversations whose LATEST message is an
-- unanswered inbound (older than the debounce window) and re-runs the agent.
--
-- `reconcile_claimed_at` is an atomic claim (FOR UPDATE SKIP LOCKED + cooldown)
-- so overlapping cron invocations never reprocess the same turn, and a turn that
-- keeps failing is retried each cooldown until it succeeds or ages out.
-- ============================================================

ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS reconcile_claimed_at timestamptz;

-- Returns unanswered inbound turns to re-run, atomically claiming each.
-- A turn qualifies when:
--   • the conversation's latest message is its last inbound (nothing after it),
--   • that inbound is older than p_min_age_seconds (past debounce+generation),
--     but newer than p_max_age_minutes (don't resurrect ancient threads),
--   • status = 'active' and no human is active,
--   • not claimed within the last p_cooldown_seconds.
-- The caller still re-applies per-tenant gates (channel/test/keyword) + isBotSuppressed.
CREATE OR REPLACE FUNCTION public.app_load_unanswered_turns(
  p_min_age_seconds  int DEFAULT 45,
  p_max_age_minutes  int DEFAULT 30,
  p_cooldown_seconds int DEFAULT 120,
  p_limit            int DEFAULT 20
) RETURNS TABLE (
  conversation_id     uuid,
  message_id          uuid,
  ghl_conversation_id text,
  ghl_contact_id      text,
  contact_phone       text,
  channel             text,
  bot_activated       boolean,
  content             text,
  ghl_message_id      text,
  ghl_location_id     text
)
LANGUAGE sql AS $$
  WITH claimed AS (
    UPDATE public.conversations cv
    SET reconcile_claimed_at = NOW()
    WHERE cv.id IN (
      SELECT c.id
      FROM public.conversations c
      JOIN public.messages lim ON lim.id = c.last_inbound_message_id
      WHERE c.status = 'active'
        AND (c.human_active_until IS NULL OR c.human_active_until < NOW())
        AND lim.sent_at < NOW() - make_interval(secs => p_min_age_seconds)
        AND lim.sent_at > NOW() - make_interval(mins => p_max_age_minutes)
        AND NOT EXISTS (
          SELECT 1 FROM public.messages m2
          WHERE m2.conversation_id = c.id AND m2.sent_at > lim.sent_at
        )
        AND (c.reconcile_claimed_at IS NULL
             OR c.reconcile_claimed_at < NOW() - make_interval(secs => p_cooldown_seconds))
      ORDER BY lim.sent_at
      LIMIT p_limit
      FOR UPDATE OF c SKIP LOCKED
    )
    RETURNING cv.id AS conv_id, cv.last_inbound_message_id AS msg_id,
              cv.ghl_conversation_id, cv.ghl_contact_id, cv.contact_phone,
              cv.channel, cv.bot_activated, cv.client_id
  )
  SELECT
    cl.conv_id,
    cl.msg_id,
    cl.ghl_conversation_id,
    cl.ghl_contact_id,
    cl.contact_phone,
    cl.channel,
    cl.bot_activated,
    lim.content,
    lim.ghl_message_id,
    t.ghl_location_id
  FROM claimed cl
  JOIN public.messages lim ON lim.id = cl.msg_id
  JOIN public.tenants t ON t.client_id = cl.client_id AND t.is_active = true;
$$;
