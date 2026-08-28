-- ============================================================
-- Migration 0057 — the lead's timezone (remote-service tenants)
-- The Bot Crew · Agent Platform
--
-- Every appointment time the bot shows is rendered in tenant_config.timezone.
-- For a walk-in business that is right: the lead comes to the clinic. For a
-- remote service (a video call) it is wrong the moment the lead lives in another
-- zone — The Bot Crew's calendar is in Tijuana and most of its leads are in
-- Mexico City time, so "las 3" meant two different hours and calls were missed.
--
-- Per conversation: lead_timezone (IANA) + where it came from.
--   'phone' — inferred by the Worker from the WhatsApp number's area code (LADA).
--             A good guess, not a fact: it only FILLS an empty column.
--   'lead'  — the lead said where they are (setLeadTimezone tool). Wins over
--             the phone guess and over any later phone re-inference.
-- Per tenant: lead_timezone_enabled. Default FALSE — for an in-person business
-- a customer with an out-of-zone number who lives in town would be offered
-- shifted hours and show up at the wrong time. Only remote-service tenants opt in.
--
-- Expand-only: nothing in the deployed Worker reads or writes these columns.
-- ============================================================

ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS lead_timezone text,
  ADD COLUMN IF NOT EXISTS lead_timezone_source text;

ALTER TABLE public.conversations DROP CONSTRAINT IF EXISTS conversations_lead_timezone_source_check;
ALTER TABLE public.conversations ADD CONSTRAINT conversations_lead_timezone_source_check
  CHECK (lead_timezone_source IS NULL OR lead_timezone_source IN ('phone', 'lead'));

ALTER TABLE public.tenant_config
  ADD COLUMN IF NOT EXISTS lead_timezone_enabled boolean NOT NULL DEFAULT false;

-- Returns true when the row was written. The precedence lives here, not in the
-- Worker, because two callers race for the column: the webhook (phone guess on
-- every inbound) and the tool (the lead's own word). A phone guess never
-- overwrites anything; the lead's word overwrites everything.
CREATE OR REPLACE FUNCTION public.app_set_lead_timezone(
  p_ghl_conversation_id text,
  p_timezone            text,
  p_source              text
) RETURNS boolean
LANGUAGE plpgsql AS $$
BEGIN
  IF p_timezone IS NULL OR p_source NOT IN ('phone', 'lead') THEN
    RETURN false;
  END IF;

  UPDATE public.conversations
  SET lead_timezone        = p_timezone,
      lead_timezone_source = p_source
  WHERE ghl_conversation_id = p_ghl_conversation_id
    AND (p_source = 'lead' OR lead_timezone IS NULL);
  RETURN FOUND;
END;
$$;

-- Per 0032: new functions are born with EXECUTE granted to PUBLIC — revoke it
-- explicitly (revoking from anon alone is a no-op) and grant service_role.
REVOKE ALL ON FUNCTION public.app_set_lead_timezone(text, text, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.app_set_lead_timezone(text, text, text) TO service_role;
