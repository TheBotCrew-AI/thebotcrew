-- ============================================================
-- Migration 0014c — pending-deliveries dedup fix
-- The Bot Crew · Agent Platform
--
-- Backfilled from remote (version 20260613224419). Captures a change that
-- had been applied directly to production but was missing from the repo.
-- ============================================================

CREATE OR REPLACE FUNCTION public.app_load_pending_deliveries(p_limit integer DEFAULT 20)
RETURNS TABLE(message_id uuid, content text, channel text, ghl_conversation_id text, ghl_contact_id text, contact_phone text, tenant_id uuid, retry_count integer)
LANGUAGE sql
AS $$
  SELECT
    m.id            AS message_id,
    m.content,
    c.channel,
    c.ghl_conversation_id,
    c.ghl_contact_id,
    c.contact_phone,
    t.id            AS tenant_id,
    m.retry_count
  FROM public.messages m
  JOIN public.conversations c ON c.id = m.conversation_id
  JOIN public.tenants t ON t.client_id = c.client_id
  WHERE m.delivery_status = 'pending'
    AND m.ghl_message_id IS NULL
    AND m.sent_at < NOW() - INTERVAL '30 seconds'
    AND m.retry_count < 3
  ORDER BY m.sent_at
  LIMIT p_limit;
$$;
