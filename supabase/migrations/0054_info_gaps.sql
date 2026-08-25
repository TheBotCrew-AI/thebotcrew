-- ============================================================
-- Migration 0054 — info gaps: what the bot could not answer, per tenant
-- The Bot Crew · Agent Platform
--
-- The bot already marks the moment it lacks a fact (`pending_info`, 0050), and a
-- human's reply in the thread is the answer the config was missing. Nobody was
-- reading either signal: on MADI the team typed the same payment answer by hand
-- in ten threads over four weeks, and four leads with a queued question were never
-- answered by anyone. This migration adds the two pieces that turn those signals
-- into work:
--
--   (1) ESCALATION — a `pending_info` that no human answered within N hours gets a
--       SECOND tag on the GHL contact (`pending_info_escalation_tag`), so it surfaces
--       in the team's own inbox instead of aging silently. Daily cron; idempotent
--       through the `pending_info_escalated` event.
--
--   (2) THE REPORT — a periodic run per tenant that selects the conversations worth
--       reading (a queued question, a human reply, a handoff), asks the model what
--       was asked / what the human answered / whether the config already had it, and
--       accumulates the answers into `info_gaps` (one row per topic, deduped across
--       runs) plus a markdown report per run. Read-only: nothing here edits
--       tenant_config. Someone decides what to load, with evals.
--
-- Cadence lives in `tenant_config.info_gaps` (NULL = feature off):
--   { "enabled": true, "min_candidates": 10, "max_days": 7, "min_for_time_run": 3 }
--   → run when ≥ min_candidates new conversations qualify, or every max_days if at
--     least min_for_time_run do (fewer than that is noise, not a pattern).
--
-- ROLLBACK: fully additive. The deployed Worker ignores every object here, so apply
-- BEFORE deploying the Worker that uses it (expand/contract rule).
-- ============================================================

-- ---------- per-tenant config ----------
ALTER TABLE public.tenant_config ADD COLUMN IF NOT EXISTS info_gaps jsonb;
COMMENT ON COLUMN public.tenant_config.info_gaps IS
  'Info-gap report cadence: {enabled, min_candidates (10), max_days (7), min_for_time_run (3)}. NULL = off.';

ALTER TABLE public.tenant_config ADD COLUMN IF NOT EXISTS pending_info_escalation_tag text;
ALTER TABLE public.tenant_config ADD COLUMN IF NOT EXISTS pending_info_escalation_hours int;
COMMENT ON COLUMN public.tenant_config.pending_info_escalation_tag IS
  'Tag ADDED to the GHL contact when a pending_info question got no human reply within pending_info_escalation_hours. NULL = no escalation.';
COMMENT ON COLUMN public.tenant_config.pending_info_escalation_hours IS
  'Hours a pending_info may wait for a human reply before escalation. NULL = 24.';

-- ---------- runs ----------
CREATE TABLE IF NOT EXISTS public.info_gap_runs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  client_id    uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  window_from  timestamptz NOT NULL,
  window_to    timestamptz NOT NULL,
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'failed')),
  candidates   int NOT NULL DEFAULT 0,
  extracted    int NOT NULL DEFAULT 0,
  gaps_found   int NOT NULL DEFAULT 0,
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz
);
CREATE INDEX IF NOT EXISTS idx_info_gap_runs_tenant ON public.info_gap_runs (tenant_id, started_at DESC);
ALTER TABLE public.info_gap_runs ENABLE ROW LEVEL SECURITY;

-- ---------- the extraction queue (one row per candidate conversation) ----------
CREATE TABLE IF NOT EXISTS public.info_gap_extractions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id          uuid NOT NULL REFERENCES public.info_gap_runs(id) ON DELETE CASCADE,
  tenant_id       uuid NOT NULL,
  conversation_id uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  reasons         text[] NOT NULL DEFAULT '{}',
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'done', 'failed')),
  attempts        int NOT NULL DEFAULT 0,
  result          jsonb,
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, conversation_id)
);
CREATE INDEX IF NOT EXISTS idx_info_gap_extractions_pending ON public.info_gap_extractions (created_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_info_gap_extractions_run ON public.info_gap_extractions (run_id, status);
ALTER TABLE public.info_gap_extractions ENABLE ROW LEVEL SECURITY;

-- ---------- the accumulated gaps (one row per tenant + topic) ----------
CREATE TABLE IF NOT EXISTS public.info_gaps (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  topic_key         text NOT NULL,
  topic             text NOT NULL,
  topic_label       text NOT NULL,
  status            text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'dismissed')),
  target            text NOT NULL DEFAULT 'offering' CHECK (target IN ('offering', 'faq', 'hours', 'prompt_bug', 'none')),
  occurrences       int NOT NULL DEFAULT 0,
  question_examples jsonb NOT NULL DEFAULT '[]'::jsonb,
  human_answers     jsonb NOT NULL DEFAULT '[]'::jsonb,
  suggested_text    text,
  closed_note       text,
  first_seen        timestamptz NOT NULL DEFAULT now(),
  last_seen         timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, topic_key)
);
CREATE INDEX IF NOT EXISTS idx_info_gaps_tenant_status ON public.info_gaps (tenant_id, status);
ALTER TABLE public.info_gaps ENABLE ROW LEVEL SECURITY;

-- ---------- reports ----------
CREATE TABLE IF NOT EXISTS public.info_gap_reports (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id     uuid NOT NULL REFERENCES public.info_gap_runs(id) ON DELETE CASCADE,
  tenant_id  uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  markdown   text NOT NULL,
  summary    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_info_gap_reports_tenant ON public.info_gap_reports (tenant_id, created_at DESC);
ALTER TABLE public.info_gap_reports ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- RPCs
-- ============================================================

-- Which conversations are worth reading in [p_from, p_to): a queued question, a human
-- reply, or a handoff. Ordered by activity so a capped enqueue keeps the freshest.
-- `reasons` labels why each qualified (the report groups by it).
CREATE OR REPLACE FUNCTION public.app_info_gap_candidates(
  p_client_id uuid,
  p_from      timestamptz,
  p_to        timestamptz
) RETURNS TABLE (
  conversation_id uuid,
  reasons         text[],
  last_message_at timestamptz
) LANGUAGE sql AS $$
  WITH pending AS (
    SELECT DISTINCT e.conversation_id
    FROM public.bot_events e
    WHERE e.client_id = p_client_id AND e.event_type = 'pending_info'
      AND e.created_at >= p_from AND e.created_at < p_to
  ),
  human AS (
    SELECT DISTINCT m.conversation_id
    FROM public.messages m
    JOIN public.conversations c ON c.id = m.conversation_id
    WHERE c.client_id = p_client_id AND m.sender_type = 'human_agent'
      AND m.sent_at >= p_from AND m.sent_at < p_to
      -- a human message that is the thread's FIRST message is a cold-outreach opener,
      -- not an answer to anything
      AND EXISTS (SELECT 1 FROM public.messages l
                  WHERE l.conversation_id = m.conversation_id AND l.sender_type = 'lead' AND l.sent_at < m.sent_at)
  ),
  handed AS (
    SELECT DISTINCT e.conversation_id
    FROM public.bot_events e
    WHERE e.client_id = p_client_id AND e.event_type = 'status_changed'
      AND e.metadata->>'to' = 'handed_off'
      AND e.created_at >= p_from AND e.created_at < p_to
  ),
  all_ids AS (
    SELECT conversation_id FROM pending
    UNION SELECT conversation_id FROM human
    UNION SELECT conversation_id FROM handed
  )
  SELECT a.conversation_id,
         ARRAY_REMOVE(ARRAY[
           CASE WHEN a.conversation_id IN (SELECT conversation_id FROM pending) THEN 'pending_info' END,
           CASE WHEN a.conversation_id IN (SELECT conversation_id FROM human)   THEN 'human_reply' END,
           CASE WHEN a.conversation_id IN (SELECT conversation_id FROM handed)  THEN 'handed_off' END
         ], NULL) AS reasons,
         c.last_message_at
  FROM all_ids a
  JOIN public.conversations c ON c.id = a.conversation_id
  ORDER BY c.last_message_at DESC;
$$;

-- Open a run and enqueue its candidates in one statement (the runner never holds a
-- half-created run). Returns the run id.
CREATE OR REPLACE FUNCTION public.app_open_info_gap_run(
  p_tenant_id uuid,
  p_client_id uuid,
  p_from      timestamptz,
  p_to        timestamptz,
  p_limit     int DEFAULT 60
) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
  v_run uuid;
  v_n   int;
BEGIN
  INSERT INTO public.info_gap_runs (tenant_id, client_id, window_from, window_to)
  VALUES (p_tenant_id, p_client_id, p_from, p_to)
  RETURNING id INTO v_run;

  INSERT INTO public.info_gap_extractions (run_id, tenant_id, conversation_id, reasons)
  SELECT v_run, p_tenant_id, c.conversation_id, c.reasons
  FROM public.app_info_gap_candidates(p_client_id, p_from, p_to) c
  LIMIT p_limit;
  GET DIAGNOSTICS v_n = ROW_COUNT;

  UPDATE public.info_gap_runs SET candidates = v_n WHERE id = v_run;
  RETURN v_run;
END;
$$;

-- Tenants with the feature on, plus what the runner needs to decide whether a run is
-- due: the last run's window end (the next window starts there) and whether one is
-- still open (never two at once per tenant).
CREATE OR REPLACE FUNCTION public.app_info_gap_tenants()
RETURNS TABLE (
  tenant_id        uuid,
  client_id        uuid,
  ghl_location_id  text,
  info_gaps        jsonb,
  last_window_to   timestamptz,
  last_started_at  timestamptz,
  has_open_run     boolean
) LANGUAGE sql AS $$
  SELECT t.id, t.client_id, t.ghl_location_id, tc.info_gaps,
         (SELECT r.window_to FROM public.info_gap_runs r
           WHERE r.tenant_id = t.id AND r.status = 'done' ORDER BY r.started_at DESC LIMIT 1),
         (SELECT r.started_at FROM public.info_gap_runs r
           WHERE r.tenant_id = t.id ORDER BY r.started_at DESC LIMIT 1),
         EXISTS (SELECT 1 FROM public.info_gap_runs r WHERE r.tenant_id = t.id AND r.status = 'open')
  FROM public.tenants t
  JOIN public.tenant_config tc ON tc.tenant_id = t.id
  WHERE t.is_active AND tc.info_gaps IS NOT NULL;
$$;

-- Atomic claim (pending → processing, SKIP LOCKED), oldest first, attempts < 3.
-- Joined with the conversation so the runner can bill tokens and log events.
CREATE OR REPLACE FUNCTION public.app_claim_info_gap_extractions(p_limit int DEFAULT 5)
RETURNS TABLE (
  id                  uuid,
  run_id              uuid,
  tenant_id           uuid,
  client_id           uuid,
  conversation_id     uuid,
  ghl_conversation_id text,
  reasons             text[],
  attempts            int
) LANGUAGE sql AS $$
  WITH claimed AS (
    UPDATE public.info_gap_extractions x
    SET status = 'processing', attempts = x.attempts + 1
    WHERE x.id IN (
      SELECT e.id FROM public.info_gap_extractions e
      WHERE e.status = 'pending' AND e.attempts < 3
      ORDER BY e.created_at
      LIMIT p_limit
      FOR UPDATE SKIP LOCKED
    )
    RETURNING x.id, x.run_id, x.tenant_id, x.conversation_id, x.reasons, x.attempts
  )
  SELECT cl.id, cl.run_id, cl.tenant_id, c.client_id, cl.conversation_id,
         c.ghl_conversation_id, cl.reasons, cl.attempts
  FROM claimed cl
  JOIN public.conversations c ON c.id = cl.conversation_id;
$$;

-- Open runs whose queue has drained (nothing pending or processing) — ready to
-- aggregate and report.
CREATE OR REPLACE FUNCTION public.app_info_gap_finalizable_runs()
RETURNS TABLE (
  id          uuid,
  tenant_id   uuid,
  client_id   uuid,
  window_from timestamptz,
  window_to   timestamptz,
  candidates  int
) LANGUAGE sql AS $$
  SELECT r.id, r.tenant_id, r.client_id, r.window_from, r.window_to, r.candidates
  FROM public.info_gap_runs r
  WHERE r.status = 'open'
    AND NOT EXISTS (SELECT 1 FROM public.info_gap_extractions e
                    WHERE e.run_id = r.id AND e.status IN ('pending', 'processing'))
  ORDER BY r.started_at;
$$;

-- Finish one extraction. A retryable failure goes back to 'pending' (attempts already
-- counted by the claim); a final one is 'failed'.
CREATE OR REPLACE FUNCTION public.app_complete_info_gap_extraction(
  p_id     uuid,
  p_status text,
  p_result jsonb DEFAULT NULL,
  p_error  text DEFAULT NULL
) RETURNS void
LANGUAGE sql AS $$
  UPDATE public.info_gap_extractions
  SET status = p_status, result = COALESCE(p_result, result), last_error = p_error
  WHERE id = p_id;
$$;

-- Merge one extracted gap into the tenant's accumulated row. Examples/answers are
-- capped so a topic asked 200 times stays readable; a `closed` row keeps counting
-- (the report shows "still being asked after we loaded it" — that is a prompt bug)
-- but is NOT reopened; a `dismissed` one is ignored entirely. Returns the row's status.
CREATE OR REPLACE FUNCTION public.app_upsert_info_gap(
  p_tenant_id      uuid,
  p_topic_key      text,
  p_topic          text,
  p_topic_label    text,
  p_target         text,
  p_question       text,
  p_human_answer   text,
  p_suggested_text text,
  p_seen_at        timestamptz
) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_status text;
BEGIN
  INSERT INTO public.info_gaps AS g
    (tenant_id, topic_key, topic, topic_label, target, occurrences,
     question_examples, human_answers, suggested_text, first_seen, last_seen)
  VALUES
    (p_tenant_id, p_topic_key, p_topic, p_topic_label, p_target, 1,
     jsonb_build_array(p_question),
     CASE WHEN p_human_answer IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(p_human_answer) END,
     p_suggested_text, p_seen_at, p_seen_at)
  ON CONFLICT (tenant_id, topic_key) DO UPDATE SET
    occurrences       = g.occurrences + 1,
    question_examples = CASE WHEN jsonb_array_length(g.question_examples) < 8
                             THEN g.question_examples || jsonb_build_array(p_question)
                             ELSE g.question_examples END,
    human_answers     = CASE WHEN p_human_answer IS NULL OR jsonb_array_length(g.human_answers) >= 8
                             THEN g.human_answers
                             ELSE g.human_answers || jsonb_build_array(p_human_answer) END,
    -- keep the first target/suggestion unless we had none
    suggested_text    = COALESCE(g.suggested_text, p_suggested_text),
    target            = CASE WHEN g.target = 'none' THEN p_target ELSE g.target END,
    last_seen         = GREATEST(g.last_seen, p_seen_at),
    updated_at        = now()
  WHERE g.status <> 'dismissed'
  RETURNING g.status INTO v_status;
  RETURN COALESCE(v_status, 'dismissed');
END;
$$;

-- Close a run with its counters.
CREATE OR REPLACE FUNCTION public.app_finish_info_gap_run(
  p_run_id     uuid,
  p_status     text,
  p_extracted  int,
  p_gaps_found int
) RETURNS void
LANGUAGE sql AS $$
  UPDATE public.info_gap_runs
  SET status = p_status, extracted = p_extracted, gaps_found = p_gaps_found, finished_at = now()
  WHERE id = p_run_id;
$$;

-- The escalation feed: conversations with a pending_info older than the tenant's
-- window that no human answered since, on tenants that configured the tag, not yet
-- escalated (no `pending_info_escalated` after the flag), and still alive.
CREATE OR REPLACE FUNCTION public.app_unanswered_pending_info()
RETURNS TABLE (
  tenant_id           uuid,
  client_id           uuid,
  conversation_id     uuid,
  ghl_conversation_id text,
  ghl_contact_id      text,
  escalation_tag      text,
  question            text,
  flagged_at          timestamptz
) LANGUAGE sql AS $$
  WITH first_flag AS (
    SELECT e.conversation_id, e.client_id,
           MIN(e.created_at) AS flagged_at,
           (ARRAY_AGG(e.metadata->>'question' ORDER BY e.created_at))[1] AS question
    FROM public.bot_events e
    WHERE e.event_type = 'pending_info'
    GROUP BY e.conversation_id, e.client_id
  )
  SELECT t.id, f.client_id, c.id, c.ghl_conversation_id, c.ghl_contact_id,
         tc.pending_info_escalation_tag, f.question, f.flagged_at
  FROM first_flag f
  JOIN public.conversations c ON c.id = f.conversation_id
  JOIN public.tenants t        ON t.client_id = f.client_id AND t.is_active
  JOIN public.tenant_config tc ON tc.tenant_id = t.id
  WHERE tc.pending_info_escalation_tag IS NOT NULL
    AND f.flagged_at < now() - make_interval(hours => COALESCE(tc.pending_info_escalation_hours, 24))
    AND c.status NOT IN ('opted_out', 'completed')
    AND c.ghl_contact_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM public.messages m
                    WHERE m.conversation_id = c.id AND m.sender_type = 'human_agent' AND m.sent_at > f.flagged_at)
    AND NOT EXISTS (SELECT 1 FROM public.bot_events x
                    WHERE x.conversation_id = c.id AND x.event_type = 'pending_info_escalated' AND x.created_at > f.flagged_at)
  ORDER BY f.flagged_at;
$$;

-- ---------- grants (0032 rule: EXECUTE off PUBLIC, on for service_role only) ----------
REVOKE ALL ON FUNCTION public.app_info_gap_candidates(uuid, timestamptz, timestamptz) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.app_info_gap_candidates(uuid, timestamptz, timestamptz) TO service_role;
REVOKE ALL ON FUNCTION public.app_open_info_gap_run(uuid, uuid, timestamptz, timestamptz, int) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.app_open_info_gap_run(uuid, uuid, timestamptz, timestamptz, int) TO service_role;
REVOKE ALL ON FUNCTION public.app_info_gap_tenants() FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.app_info_gap_tenants() TO service_role;
REVOKE ALL ON FUNCTION public.app_claim_info_gap_extractions(int) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.app_claim_info_gap_extractions(int) TO service_role;
REVOKE ALL ON FUNCTION public.app_info_gap_finalizable_runs() FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.app_info_gap_finalizable_runs() TO service_role;
REVOKE ALL ON FUNCTION public.app_complete_info_gap_extraction(uuid, text, jsonb, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.app_complete_info_gap_extraction(uuid, text, jsonb, text) TO service_role;
REVOKE ALL ON FUNCTION public.app_upsert_info_gap(uuid, text, text, text, text, text, text, text, timestamptz) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.app_upsert_info_gap(uuid, text, text, text, text, text, text, text, timestamptz) TO service_role;
REVOKE ALL ON FUNCTION public.app_finish_info_gap_run(uuid, text, int, int) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.app_finish_info_gap_run(uuid, text, int, int) TO service_role;
REVOKE ALL ON FUNCTION public.app_unanswered_pending_info() FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.app_unanswered_pending_info() TO service_role;

-- ---------- observability ----------
-- pending_info_escalated: the second tag went on.
-- info_gap_error: an escalation could not be tagged, or an extraction failed for good.
-- (Run-level outcomes live in info_gap_runs itself — no event for those.)
-- The list is prod's CURRENT one (0053) plus the two new types.
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
    'followup_aborted', 'demo_reminder_sent', 'status_change_blocked',
    'attachment_received', 'attachment_failed',
    'capi_event_sent', 'capi_error',
    'reactivation_exhausted', 'pending_info',
    'resume_skipped',
    'pending_info_escalated', 'info_gap_error'
  ]));
