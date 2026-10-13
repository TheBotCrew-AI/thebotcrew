-- ============================================================
-- Migration 0070 — sequence mode: the playbook as an ordered story per stage
-- The Bot Crew · Agent Platform
--
-- 0068 gave each stage a POOL of angles the model picks from; 0069 let an angle
-- deliver a file. This release adds the other shape: a stage may carry a
-- SEQUENCE of steps, each marked with what it COVERS (precio, quien,
-- que-esperar, prueba, oferta, duda, cierre). Rung N sends the first step whose
-- mark the conversation hasn't covered yet — so the arc reads as a story and a
-- lead who already saw the price is never sent the price again. Marks are per
-- CONVERSATION, not per stage: rising NI → I skips what NI already told them.
--
-- One stamp on follow_ups:
--   · step   the mark the sent nudge covered (NULL = angle mode, free-form, or a
--            row from before 0070). This is the cursor the runner reads back.
--
-- Expand/contract: app_mark_follow_up_sent gains p_step DEFAULT NULL — the 3-arg
-- overload is DROPPED and recreated (same reason as 0063/0068: two overloads
-- make the deployed Worker's 3-arg call ambiguous). The deployed Worker's call
-- still resolves against the new signature.
--
-- The view follow_up_step_outcomes is the metric of the arc: per tenant, stage
-- and step, how many went out and how many got the lead to write back before
-- the next rung. One week of it before anyone reorders a sequence.
-- ============================================================

ALTER TABLE public.follow_ups
  ADD COLUMN IF NOT EXISTS step text;

ALTER TABLE public.follow_ups DROP CONSTRAINT IF EXISTS follow_ups_step_check;
ALTER TABLE public.follow_ups ADD CONSTRAINT follow_ups_step_check
  CHECK (step IS NULL OR step ~ '^[a-z]+(-[a-z]+)*$');

COMMENT ON COLUMN public.follow_ups.step IS
  'Sequence mode (0070): the cover mark this nudge delivered (precio, quien, que-esperar, prueba, oferta, duda, cierre). NULL = angle mode or free-form.';

-- ---------- app_mark_follow_up_sent: + p_step ----------
DROP FUNCTION IF EXISTS public.app_mark_follow_up_sent(uuid, integer, text);

CREATE FUNCTION public.app_mark_follow_up_sent(
  p_follow_up_id uuid,
  p_angle_index  integer DEFAULT NULL::integer,
  p_angle_pool   text    DEFAULT NULL::text,
  p_step         text    DEFAULT NULL::text
) RETURNS void
LANGUAGE sql AS $$
  WITH marked AS (
    UPDATE public.follow_ups
    SET status = 'sent', sent_at = NOW(),
        angle_index = p_angle_index, angle_pool = p_angle_pool,
        step = CASE WHEN p_step ~ '^[a-z]+(-[a-z]+)*$' THEN p_step ELSE NULL END
    WHERE id = p_follow_up_id
      AND status = 'sending'
    RETURNING conversation_id, kind, tier, round
  )
  UPDATE public.conversations c
  SET reactivation_round = GREATEST(c.reactivation_round, m.round + 1)
  FROM marked m
  WHERE c.id = m.conversation_id
    AND m.kind = 'cadence'
    AND m.tier = 1;
$$;

REVOKE ALL ON FUNCTION public.app_mark_follow_up_sent(uuid, integer, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.app_mark_follow_up_sent(uuid, integer, text, text) TO service_role;

-- ---------- the metric of the arc ----------
-- A step "got a reply" when the lead wrote after it and before the next nudge of
-- that conversation went out (or before now, for the latest one).
CREATE OR REPLACE VIEW public.follow_up_step_outcomes
WITH (security_invoker = on) AS
WITH sent AS (
  SELECT fu.id, fu.conversation_id, fu.stage, fu.step, fu.tier, fu.sent_at,
         LEAD(fu.sent_at) OVER (PARTITION BY fu.conversation_id ORDER BY fu.sent_at) AS next_sent_at
  FROM public.follow_ups fu
  WHERE fu.status = 'sent' AND fu.kind = 'cadence' AND fu.step IS NOT NULL
)
SELECT c.client_id,
       COALESCE(s.stage, 'none') AS stage,
       s.step,
       count(*) AS sent,
       count(*) FILTER (WHERE EXISTS (
         SELECT 1 FROM public.messages m
         WHERE m.conversation_id = s.conversation_id
           AND m.direction = 'inbound'
           AND m.sent_at > s.sent_at
           AND m.sent_at < COALESCE(s.next_sent_at, NOW())
       )) AS replied
FROM sent s
JOIN public.conversations c ON c.id = s.conversation_id
GROUP BY c.client_id, COALESCE(s.stage, 'none'), s.step;

REVOKE ALL ON public.follow_up_step_outcomes FROM anon, authenticated;
