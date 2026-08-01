-- ============================================================
-- Migration 0043 — follow-up send gate + demo reminders
-- The Bot Crew · Agent Platform
--
-- TWO problems, one table.
--
-- (1) THE SEND RACE. `app_load_due_follow_ups` already claims atomically
--     (pending → processing, SKIP LOCKED), which protects against two runners
--     grabbing the same row. What was unprotected is the 10-40s window between
--     that claim and the actual GHL send, spent generating the LLM reply. If the
--     lead answers inside it, `app_cancel_follow_ups` flips processing →
--     cancelled, but the runner never re-read the row: it sent anyway, and
--     `app_mark_follow_up_sent` (an unconditional UPDATE) overwrote 'cancelled'
--     back to 'sent'. So the nudge chased a lead who was mid-reply AND the audit
--     trail claimed everything was fine.
--     Observed 2026-07-31 on conversation b5bf41b4: inbound 15:29:06, nudge sent
--     15:29:14, demo start 15:29:38 — three messages in 32 seconds, one of them
--     asking a question the lead had just answered.
--
--     Fix: a 'sending' state plus `app_commit_follow_up_send`, a conditional
--     claim the runner must win immediately before handing the text to GHL. It
--     re-checks three things in ONE atomic statement: the row is still
--     'processing' (nobody cancelled it), the conversation's last inbound is
--     still the one we planned against (no new message even if the cancel
--     lagged — it is fire-and-forget), and the conversation is still active.
--     `app_mark_follow_up_sent` now requires 'sending', so it can no longer
--     resurrect a cancelled row.
--
-- (2) DEMO REMINDERS. Follow-ups are suppressed entirely while active_role =
--     'demo', because the reactivation agent is persona-blind and its nudges
--     shatter the roleplay. Correct, but it left a hole: a lead who walks away
--     mid-demo gets nothing, ever. Session expiry is only evaluated on the NEXT
--     inbound, so if they never write again the conversation sits in 'demo'
--     forever and the lead is dead.
--     Fix: `kind` — 'cadence' (the 44-angle reactivation ladder) or 'demo'
--     (three deterministic, LLM-free, parenthesised out-of-character nudges that
--     only say the demo is still open and how to close it). The third one ends
--     the session and hands the lead to the closer, so the normal ladder can
--     take over.
--
-- EXPAND/CONTRACT — this migration is NOT purely additive, so read before
-- applying. Schema changes are (defaulted column, widened CHECK, new overload),
-- but two function bodies change under the currently deployed Worker:
--   · `app_load_due_follow_ups` must be DROP+CREATE, not REPLACE — its RETURNS
--     TABLE grows two columns and Postgres refuses to replace a return type.
--     Migrations run in a transaction, so a concurrent caller blocks rather than
--     errors, and the old Worker maps by column name (extra columns are inert).
--   · `app_mark_follow_up_sent` starts requiring 'sending'. The old Worker never
--     sets it, so between this migration and the deploy its follow-ups still
--     send, but the row stays 'processing' and its angle_index goes unrecorded —
--     one angle may repeat once. It cannot double-send (the row is no longer
--     'pending'). Apply this migration close to the deploy to keep that short.
-- To revert: restore the REPLACEd functions from 0012/0020, drop the 4-arg
-- overload + `app_commit_follow_up_send`, and sweep any row left in 'sending'
-- to 'cancelled' (it means a send was in flight when the world stopped).
-- CONTRACT (later release, once this deploy is proven): drop the 3-arg
-- `app_schedule_follow_up` overload.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Schema: the in-flight state + the two ladders.
-- ------------------------------------------------------------
ALTER TABLE public.follow_ups DROP CONSTRAINT IF EXISTS follow_ups_status_check;
ALTER TABLE public.follow_ups ADD CONSTRAINT follow_ups_status_check
  CHECK (status = ANY (ARRAY['pending', 'processing', 'sending', 'sent', 'cancelled', 'failed']));

ALTER TABLE public.follow_ups
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'cadence';

ALTER TABLE public.follow_ups DROP CONSTRAINT IF EXISTS follow_ups_kind_check;
ALTER TABLE public.follow_ups ADD CONSTRAINT follow_ups_kind_check
  CHECK (kind = ANY (ARRAY['cadence', 'demo']));

-- The demo ladder's cursor: "how many demo reminders has this conversation
-- already been sent?" Same shape as the angle cursor (loadSentAngleIndexes),
-- and indexed for the same reason — it is read on every demo turn.
CREATE INDEX IF NOT EXISTS follow_ups_conv_kind_status_idx
  ON public.follow_ups (conversation_id, kind, status);

-- ------------------------------------------------------------
-- 2. A cancel must also stop a send already in flight.
--    Without 'sending' here, the commit gate below would be pointless: the
--    runner would win a claim the lead's reply could no longer take back.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.app_cancel_follow_ups(p_conversation_id uuid)
RETURNS void
LANGUAGE sql AS $$
  UPDATE public.follow_ups
  SET status = 'cancelled'
  WHERE conversation_id = p_conversation_id
    AND status IN ('pending', 'processing', 'sending');
$$;

-- ------------------------------------------------------------
-- 3. Due-row claim — now also hands back the baseline the commit gate compares
--    against (last_inbound_message_id) and which ladder the row belongs to.
-- ------------------------------------------------------------
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
  last_inbound_message_id uuid
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
      follow_ups.kind            AS f_kind
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
    c.last_inbound_message_id
  FROM claimed cl
  JOIN public.conversations c ON c.id = cl.f_conv_id
  JOIN public.tenants t ON t.client_id = c.client_id;
$$;

-- ------------------------------------------------------------
-- 4. THE COMMIT GATE. Called immediately before the GHL send; NULL means abort.
--
--    `p_last_inbound_id` is the value read when the row was claimed. Comparing
--    it with IS NOT DISTINCT FROM (not =) matters: a brand-new conversation has
--    NULL there, and `NULL = NULL` is NULL, which would abort every first nudge.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.app_commit_follow_up_send(
  p_follow_up_id    uuid,
  p_last_inbound_id uuid
) RETURNS uuid
LANGUAGE sql AS $$
  UPDATE public.follow_ups fu
  SET status = 'sending'
  FROM public.conversations c
  WHERE fu.id = p_follow_up_id
    AND c.id = fu.conversation_id
    AND fu.status = 'processing'
    AND c.status = 'active'
    AND c.last_inbound_message_id IS NOT DISTINCT FROM p_last_inbound_id
  RETURNING fu.id;
$$;

-- ------------------------------------------------------------
-- 5. Marking sent now requires having won the gate. This is the half that stops
--    a cancelled row from being rewritten to 'sent' after the fact.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.app_mark_follow_up_sent(
  p_follow_up_id uuid,
  p_angle_index  integer DEFAULT NULL::integer
) RETURNS void
LANGUAGE sql AS $$
  UPDATE public.follow_ups
  SET status = 'sent', sent_at = NOW(), angle_index = p_angle_index
  WHERE id = p_follow_up_id
    AND status = 'sending';
$$;

-- ------------------------------------------------------------
-- 6. Scheduling with a ladder. NEW 4-arg overload — the 3-arg version from 0012
--    stays exactly as it is so the deployed Worker is unaffected while the CF
--    deploy and this migration are out of sync (expand/contract, CLAUDE.md).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.app_schedule_follow_up(
  p_conversation_id uuid,
  p_tier            integer,
  p_scheduled_for   timestamptz,
  p_kind            text
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

  INSERT INTO public.follow_ups (conversation_id, tier, status, scheduled_for, kind)
  VALUES (p_conversation_id, p_tier, 'pending', p_scheduled_for, COALESCE(p_kind, 'cadence'))
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

-- ------------------------------------------------------------
-- 7. The demo ladder's cursor. Counts only DELIVERED demo reminders, so a
--    reminder that was cancelled (lead came back) or aborted at the gate never
--    burns a rung — the lead still gets all three across the session.
--    Without this the tier would reset to 1 on every reply and reminder #2
--    ("write X to close it") would never be reached.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.app_count_sent_demo_reminders(p_conversation_id uuid)
RETURNS integer
LANGUAGE sql STABLE AS $$
  SELECT COUNT(*)::int
  FROM public.follow_ups
  WHERE conversation_id = p_conversation_id
    AND kind = 'demo'
    AND status = 'sent';
$$;

-- ------------------------------------------------------------
-- 8. Observability. `followup_aborted` is the one that matters: it is the only
--    record that a nudge was correctly NOT sent, and its absence is what made
--    the old race invisible (the row was rewritten to 'sent' and looked normal).
-- ------------------------------------------------------------
ALTER TABLE public.bot_events DROP CONSTRAINT IF EXISTS bot_events_event_type_check;
ALTER TABLE public.bot_events ADD CONSTRAINT bot_events_event_type_check
  CHECK (event_type = ANY (ARRAY[
    'lead_qualified', 'follow_up_sent', 'no_show_recovered', 'out_of_hours_handled',
    'objection_handled', 'reactivation_sent', 'agent_error', 'db_error', 'delivery_error',
    'run_superseded', 'run_suppressed', 'handoff_tag_on', 'handoff_tag_off',
    'channel_disabled', 'test_mode_skip', 'keyword_required', 'bot_activated',
    'availability_checked', 'booking_failed', 'status_changed', 'turn_scheduled',
    'demo_toggled', 'ai_key_fallback', 'awaiting_human', 'variant_assigned',
    'demo_session_started', 'demo_session_ended', 'lead_disqualified',
    'followup_aborted', 'demo_reminder_sent'
  ]));

-- ------------------------------------------------------------
-- 9. Grants — every app_* RPC is SECURITY INVOKER, revoked from PUBLIC (not
--    just anon: Postgres grants EXECUTE to PUBLIC by default) and granted to
--    service_role only. Same rule as 0032; a new function silently reopens the
--    Data API hole otherwise.
-- ------------------------------------------------------------
REVOKE ALL ON FUNCTION public.app_load_due_follow_ups(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.app_commit_follow_up_send(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.app_schedule_follow_up(uuid, integer, timestamptz, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.app_count_sent_demo_reminders(uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.app_load_due_follow_ups(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.app_commit_follow_up_send(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.app_schedule_follow_up(uuid, integer, timestamptz, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.app_count_sent_demo_reminders(uuid) TO service_role;
