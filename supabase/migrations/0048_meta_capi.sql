-- ============================================================
-- Migration 0048 — Meta Conversions API (CTWA lead-quality signals)
-- The Bot Crew · Agent Platform
--
-- Engagement click-to-WhatsApp ads deliver bad leads because Meta never hears
-- which conversations turned into anything. This adds the plumbing to send
-- conversion events back per tenant: the attribution key captured on the
-- conversation, a per-tenant config column, and a durable outbound queue the
-- Worker drains to the Graph API on the 1-minute cron.
--
-- Attribution: Meta requires the click id (`ctwa_clid`) to attribute a
-- conversion to the ad click. GHL drops it from webhooks but exposes it on the
-- contact record — verified 2026-08-01 against a live MADI CTWA lead:
--   GET /contacts/{id} → contact.attributionSource.ctwaClid (+ adId, adName,
--   sessionSource 'Paid Social'). The Worker captures it at the turn-start
--   contact fetch and stores it here, first-touch sticky.
--
-- tenant_config.meta_capi (NULL = feature off) shape:
--   { "dataset_id": "...", "page_id": "...", "token_ref": "MADI",
--     "test_event_code": "TEST1234",              -- only during verification
--     "events": { "lead_started": false,          -- false disables a kind
--                 "appointment_booked": { "name": "Purchase",
--                                          "value": 350, "currency": "MXN" } } }
-- token_ref is a SLUG → Worker secret META_CAPI_TOKEN__<SLUG>. Never key
-- material in the DB. There is deliberately NO platform fallback token: a
-- cross-advertiser token is meaningless, so a missing secret parks the queue
-- rows pending (loud capi_error) until the secret lands.
--
-- ROLLBACK: fully additive. The deployed Worker ignores every object here, so
-- apply BEFORE deploying the Worker that uses it (expand/contract rule).
-- ============================================================

-- Per-tenant config (NULL = feature off; every existing tenant unaffected).
ALTER TABLE public.tenant_config ADD COLUMN IF NOT EXISTS meta_capi jsonb;
COMMENT ON COLUMN public.tenant_config.meta_capi IS
  'Meta Conversions API config: {dataset_id, page_id, token_ref (secret slug), test_event_code?, events?}. NULL = off.';

-- Attribution captured on the conversation (first-touch sticky, set once).
ALTER TABLE public.conversations ADD COLUMN IF NOT EXISTS ctwa_clid text;
ALTER TABLE public.conversations ADD COLUMN IF NOT EXISTS attribution jsonb;
COMMENT ON COLUMN public.conversations.ctwa_clid IS
  'Meta click-to-WhatsApp click id (from GHL contact.attributionSource). Required by CAPI to attribute events to the ad.';
COMMENT ON COLUMN public.conversations.attribution IS
  'Raw GHL attributionSource snapshot (adId, adName, sessionSource, …) for per-ad lead-quality reporting.';

-- Durable outbound queue (the messages.delivery_status idiom, own table).
-- payload is the frozen {user_data, custom_data} snapshot built at enqueue;
-- token/test_event_code are NOT frozen — the drain reads them fresh from
-- tenant_config so a token rotation needs no re-enqueue.
CREATE TABLE IF NOT EXISTS public.capi_events (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id           uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  ghl_conversation_id text NOT NULL,
  kind                text NOT NULL CHECK (kind IN ('lead_started', 'appointment_booked', 'conversation_completed')),
  event_name          text NOT NULL,
  -- `${ghl_conversation_id}:${kind}` — one event per conversation per kind.
  -- Doubles as Meta's event_id (their dedup), so even a re-sent row can't double-count.
  event_id            text NOT NULL UNIQUE,
  event_time          timestamptz NOT NULL DEFAULT now(),
  payload             jsonb NOT NULL,
  status              text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  attempts            int  NOT NULL DEFAULT 0,
  last_error          text,
  sent_at             timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_capi_events_pending ON public.capi_events (created_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_capi_events_client  ON public.capi_events (client_id);

-- Deny-by-default (0032 rule): RLS on, zero policies. The Worker's service-role
-- key bypasses RLS; the Data API sees nothing.
ALTER TABLE public.capi_events ENABLE ROW LEVEL SECURITY;

-- Idempotent enqueue: true = this call inserted the row (callers may log then).
CREATE OR REPLACE FUNCTION public.app_enqueue_capi_event(
  p_client_id           uuid,
  p_ghl_conversation_id text,
  p_kind                text,
  p_event_name          text,
  p_event_id            text,
  p_payload             jsonb
) RETURNS boolean
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO public.capi_events (client_id, ghl_conversation_id, kind, event_name, event_id, payload)
  VALUES (p_client_id, p_ghl_conversation_id, p_kind, p_event_name, p_event_id, p_payload)
  ON CONFLICT (event_id) DO NOTHING;
  RETURN FOUND;
END;
$$;

-- Drain: pending rows below the attempt cap, oldest first, joined with the
-- tenant's LIVE meta_capi config (token_ref / test_event_code read fresh each
-- run). Rows whose client has no active tenant are invisible here — they age
-- into the runner's 48h expiry rather than erroring every minute.
CREATE OR REPLACE FUNCTION public.app_load_pending_capi_events(p_limit int DEFAULT 20)
RETURNS TABLE (
  id                  uuid,
  client_id           uuid,
  ghl_conversation_id text,
  kind                text,
  event_name          text,
  event_id            text,
  event_time          timestamptz,
  payload             jsonb,
  attempts            int,
  last_error          text,
  created_at          timestamptz,
  tenant_id           uuid,
  meta_capi           jsonb
) LANGUAGE sql AS $$
  SELECT e.id, e.client_id, e.ghl_conversation_id, e.kind, e.event_name,
         e.event_id, e.event_time, e.payload, e.attempts,
         e.last_error, e.created_at, t.id, tc.meta_capi
  FROM public.capi_events e
  JOIN public.tenants t        ON t.client_id = e.client_id AND t.is_active
  JOIN public.tenant_config tc ON tc.tenant_id = t.id
  WHERE e.status = 'pending' AND e.attempts < 3
  ORDER BY e.created_at
  LIMIT p_limit;
$$;

-- Status transition. Also used to park a pending row with a diagnostic
-- last_error (status stays 'pending') so the runner logs a condition only once.
CREATE OR REPLACE FUNCTION public.app_mark_capi_event(
  p_id     uuid,
  p_status text,
  p_error  text DEFAULT NULL
) RETURNS void
LANGUAGE sql AS $$
  UPDATE public.capi_events
  SET status     = p_status,
      last_error = p_error,
      sent_at    = CASE WHEN p_status = 'sent' THEN now() ELSE sent_at END
  WHERE id = p_id;
$$;

CREATE OR REPLACE FUNCTION public.app_increment_capi_attempts(p_id uuid)
RETURNS void
LANGUAGE sql AS $$
  UPDATE public.capi_events SET attempts = attempts + 1 WHERE id = p_id;
$$;

REVOKE ALL ON FUNCTION public.app_enqueue_capi_event(uuid, text, text, text, text, jsonb) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.app_enqueue_capi_event(uuid, text, text, text, text, jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.app_load_pending_capi_events(int) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.app_load_pending_capi_events(int) TO service_role;
REVOKE ALL ON FUNCTION public.app_mark_capi_event(uuid, text, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.app_mark_capi_event(uuid, text, text) TO service_role;
REVOKE ALL ON FUNCTION public.app_increment_capi_attempts(uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.app_increment_capi_attempts(uuid) TO service_role;

-- New observability: capi_event_sent (a conversion signal reached Meta) and
-- capi_error (send failed / secret missing / config gone / row expired).
-- The full list is prod's CURRENT one (read via pg_get_constraintdef on
-- 2026-08-01, identical to 0046's) plus the two new types.
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
    'capi_event_sent', 'capi_error'
  ]));
