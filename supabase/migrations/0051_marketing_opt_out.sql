-- ============================================================
-- Migration 0051 — marketing opt-out: a date, and nothing else
-- The Bot Crew · Agent Platform
--
-- GHL now sends marketing campaigns that have NOTHING to do with the bot. When a
-- contact opts out of those, the operator tags them `marketing-opt-out` in GHL.
-- This records WHEN that happened. That is the whole feature.
--
-- NOT the same thing as `bot-opted-out` (0045). That one is consent about the
-- conversation — the lead told the bot to stop, and it mutes the bot. This one is
-- consent about broadcast marketing, it is owned by GHL's campaign tooling, and it
-- changes NO behaviour here: nothing in the Worker reads this column. Deliberately
-- inert — a track record for whoever queries it later, not a gate.
--
-- WRITE-ONCE, and that is the point. Whether a contact is opted out *right now* is
-- already in GHL, live, on the tag itself; the only thing this column adds is the
-- date consent was withdrawn. Clearing it on tag removal would delete the sole
-- piece of information it contributes and leave a worse copy of the tag. So:
--   tag present + column NULL → stamp now()
--   tag present + already set → no-op, the ORIGINAL date survives a re-opt-out
--   tag absent                → no-op (the handler never even calls this)
-- Idempotent, which also means GHL re-firing this webhook on every OTHER tag
-- change — it always sends the contact's full tag list — costs nothing.
--
-- `timestamptz`, like every other timestamp in this schema: stored UTC, offset
-- aware, rendered in whatever timezone the reader asks for.
--
-- SCOPE CAVEAT — read before trusting a report built on this. The column lives on
-- `conversations`, so it only reaches contacts who have talked to the bot at least
-- once. A pure marketing-list contact that never messaged us has no row here, and
-- their opt-out lands nowhere (the RPC returns 0). A contact WITH rows gets all of
-- them stamped, and a conversation row created AFTER the opt-out is born NULL — so
-- the question to ask is "does this contact have ANY row with a date", never "is
-- this row stamped". If the record ever needs to cover contacts the bot never
-- spoke to, that is a real `contacts` table, not this column.
--
-- ROLLBACK: drop the column and `app_set_marketing_opt_out_by_contact`. No
-- behaviour depends on either.
-- ============================================================

ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS marketing_opted_out_at timestamptz;

COMMENT ON COLUMN public.conversations.marketing_opted_out_at IS
  'When the contact was first seen carrying GHL''s `marketing-opt-out` tag — consent withdrawn for GHL marketing campaigns, which are separate from the bot. Write-once: never cleared, never overwritten, so a re-opt-out keeps the original date. Nothing in the Worker reads it; it is a track record. Distinct from `bot-opted-out` / status opted_out (0045), which is about the conversation and DOES mute the bot.';

-- ------------------------------------------------------------
-- Contact-scoped stamp. Mirrors the shape of the other tag switches
-- (`app_set_bot_off_by_contact`, `app_clear_opted_out_by_contact`): keyed by GHL
-- contact id, returns how many rows changed.
--
-- The `IS NULL` predicate is what makes it write-once — it is the whole guard, so
-- the caller can fire on every webhook without thinking. Returning 0 on the second
-- call is the normal case, not an error.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.app_set_marketing_opt_out_by_contact(p_ghl_contact_id text)
RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
  v_count int;
BEGIN
  UPDATE public.conversations
     SET marketing_opted_out_at = now()
   WHERE ghl_contact_id = p_ghl_contact_id
     AND marketing_opted_out_at IS NULL;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- ------------------------------------------------------------
-- Grants — 0032 rule: revoke from PUBLIC (Postgres grants EXECUTE to PUBLIC by
-- default, so revoking from anon alone is a no-op), then grant to service_role.
-- ------------------------------------------------------------
REVOKE ALL ON FUNCTION public.app_set_marketing_opt_out_by_contact(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_set_marketing_opt_out_by_contact(text) TO service_role;
