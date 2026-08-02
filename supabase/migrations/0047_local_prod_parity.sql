-- ============================================================
-- Migration 0047 — local/prod parity (repairs the 0014a–d gap)
-- The Bot Crew · Agent Platform
--
-- WHY THIS EXISTS. The Supabase CLI keys its local ledger on a NUMERIC version
-- prefix. A letter-suffixed file (`0014a_…`) does not match, so the CLI SKIPS IT
-- SILENTLY — only `0014` was ever recorded locally. `0014a`, `0014b`, `0014c` and
-- `0014d` therefore never ran against a local database, while prod has them (they
-- were applied there by hand and backfilled into the repo afterwards).
--
-- This is the exact opposite of what CLAUDE.md advised ("use a letter suffix when
-- inserting between numbers") — that note has been corrected in the same change.
-- The practical consequence was worse than a stale local DB: every local dry-run
-- since 2026-07-28 has been validating against a schema that silently differed
-- from production, which is precisely what dry-runs exist to prevent.
--
-- A full local↔prod diff (constraints, function bodies, columns) found the drift
-- is limited to TWO objects. Everything else had already been overwritten by
-- later migrations, and six functions that looked different differed only in
-- comments — verified by comparing comment-stripped bodies.
--
--   1. conversations_channel_check — local lacked 'facebook' (from 0014b), so any
--      local test touching a FB conversation failed on a constraint that prod
--      does not have. That is how this was found.
--   2. app_load_pending_deliveries — local still had the pre-0014c body, missing
--      the `ghl_message_id IS NULL` guard that stops the delivery-retry cron from
--      re-sending a message GHL had already accepted.
--
-- Not repaired, deliberately: `n8n_chat_histories` exists only in prod (a legacy
-- artifact). 0032 already guards it with `to_regclass`, so its absence locally is
-- intentional, not drift.
--
-- This migration is a NO-OP against production — it re-asserts what prod already
-- has, so applying it there only aligns the ledgers. Verified by comparing object
-- hashes before and after.
-- ============================================================

-- 1. Facebook is a real channel (0014b).
ALTER TABLE public.conversations DROP CONSTRAINT IF EXISTS conversations_channel_check;
ALTER TABLE public.conversations ADD CONSTRAINT conversations_channel_check
  CHECK (channel IN ('whatsapp', 'instagram', 'facebook'));

-- 2. The delivery-retry cron must never re-send an accepted message (0014c).
--    Body copied from prod's live definition, not replayed from the 0014c file.
CREATE OR REPLACE FUNCTION public.app_load_pending_deliveries(p_limit integer DEFAULT 20)
RETURNS TABLE(
  message_id uuid, content text, channel text, ghl_conversation_id text,
  ghl_contact_id text, contact_phone text, tenant_id uuid, retry_count integer
)
LANGUAGE sql
AS $function$
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
$function$;

REVOKE ALL ON FUNCTION public.app_load_pending_deliveries(integer) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.app_load_pending_deliveries(integer) TO service_role;
