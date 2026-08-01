-- ============================================================
-- Migration 0045 — `opted_out` silences the bot (and a way back)
-- The Bot Crew · Agent Platform
--
-- Until now `opted_out` did NOT mute anything. It only turned automated nudges
-- off (via the `status = 'active'` requirement in the follow-up RPCs), so a lead
-- who had said "no me escribas" still got a full reply every time they wrote.
-- `app_is_bot_suppressed` muted on `handed_off` alone. That is the gap this
-- closes: consent should stop the conversation, not just the nudges.
--
-- The farewell still goes out. The classifier stamps `opted_out` BEFORE the
-- reply is sent (webhook-handler.ts), so a mute enforced at send time would kill
-- the bot's own "listo, no te molesto más" and leave the lead with silence. It
-- doesn't, because the pre-send re-check deliberately calls `isHumanActive`, not
-- `isBotSuppressed` — the same reason the agent's own self-handoff can still say
-- goodbye. The mute therefore starts at the NEXT inbound, which is the turn-start
-- gate. Do not "fix" that asymmetry without re-reading this paragraph.
--
-- AND A WAY BACK — the reason this is two changes, not one. `opted_out` is set by
-- the outcome CLASSIFIER, an LLM call. Before this migration a false positive cost
-- the lead their follow-ups and nothing else: the bot kept answering, so the lead
-- could always talk their way back. Muting turns the same false positive into a
-- lead who is ignored forever, in silence — and nothing could undo it:
-- `app_reactivate_conversation` skips `opted_out` on purpose (consent), and the
-- `bot-opted-out` tag the bot writes was write-only, read by nobody. The only
-- remedy was hand-written SQL.
-- So removing that tag in GHL now clears the state, mirroring `bot-off`. It is
-- deliberately ONE-DIRECTIONAL: adding the tag does NOT opt anyone out (the lead
-- and the classifier own that decision), removing it is the operator saying "this
-- one was wrong". Every clear writes a `status_changed {via:'opted_out_tag'}`
-- event, so a resurrected opt-out is always auditable — that audit trail matters
-- more here than anywhere else in the system.
--
-- ROLLBACK: restore `app_is_bot_suppressed` from 0013 (drop the opted_out term)
-- and drop `app_clear_opted_out_by_contact`. No schema change, no data change.
-- ============================================================

-- ------------------------------------------------------------
-- 1. The mute. `handed_off` and the human's sliding 5-min timer keep their
--    existing meaning; `opted_out` joins them as a permanent stop.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.app_is_bot_suppressed(p_ghl_conversation_id text)
RETURNS boolean
LANGUAGE sql AS $$
  SELECT COALESCE(
    (
      SELECT status IN ('handed_off', 'opted_out')
          OR (human_active_until IS NOT NULL AND human_active_until > NOW())
      FROM public.conversations
      WHERE ghl_conversation_id = p_ghl_conversation_id
    ),
    false
  );
$$;

-- ------------------------------------------------------------
-- 2. The way back: contact-scoped, clear-only.
--
--    Only touches rows that are actually `opted_out`, so it can never override
--    `handed_off` (the stronger signal) and returns 0 when there is nothing to
--    undo — which is also why the bot writing the tag itself cannot loop: this
--    is only ever called on the tag's ABSENCE.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.app_clear_opted_out_by_contact(p_ghl_contact_id text)
RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
  v_row   record;
  v_count int := 0;
BEGIN
  FOR v_row IN
    SELECT id, client_id
    FROM public.conversations
    WHERE ghl_contact_id = p_ghl_contact_id
      AND status = 'opted_out'
    FOR UPDATE
  LOOP
    UPDATE public.conversations SET status = 'active' WHERE id = v_row.id;

    -- Loud on purpose: undoing a "stop" is the one state change here that could
    -- put us in front of someone who asked us not to be.
    INSERT INTO public.bot_events (client_id, conversation_id, event_type, metadata)
    VALUES (v_row.client_id, v_row.id, 'status_changed',
            jsonb_build_object('from', 'opted_out', 'to', 'active', 'via', 'opted_out_tag'));

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$;

-- ------------------------------------------------------------
-- 3. Grants — 0032 rule: revoke from PUBLIC (Postgres grants EXECUTE to PUBLIC
--    by default, so revoking from anon alone is a no-op), grant to service_role.
-- ------------------------------------------------------------
REVOKE ALL ON FUNCTION public.app_clear_opted_out_by_contact(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_clear_opted_out_by_contact(text) TO service_role;
