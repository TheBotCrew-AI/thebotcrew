-- ============================================================
-- Migration 0039 — tenant_config history (audit trail)
-- The Bot Crew · Agent Platform
--
-- tenant_config is production behavior (prompts, gates, cadences) edited by
-- hand, with no record of what changed or when. A bad prompt_overrides edit
-- today is undiffable and unrevertable, and "which config was live when that
-- lead went silent?" is unanswerable. This closes that: a trigger snapshots
-- the FULL row on every INSERT / UPDATE / DELETE.
--
-- Design notes:
-- - Full-row jsonb snapshots, not field diffs: diffing two jsonb rows in SQL
--   is trivial; reconstructing a row from partial diffs is not. Revert = read
--   the snapshot, write the row.
-- - The trigger fn is SECURITY DEFINER so the insert succeeds no matter which
--   role performs the edit (SQL editor as postgres, Worker as service_role, a
--   future dashboard under a limited role with RLS).
-- - INSERT is also captured so row #1 is the tenant's initial config.
--
-- ROLLBACK: drop the trigger + function + table. Purely additive; no code
-- reads this table (it exists for humans and future tooling).
-- ============================================================

CREATE TABLE public.tenant_config_history (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id  uuid NOT NULL,
  op         text NOT NULL CHECK (op IN ('INSERT', 'UPDATE', 'DELETE')),
  -- The row AFTER the change (for DELETE: the row that was deleted).
  config     jsonb NOT NULL,
  changed_by text NOT NULL DEFAULT current_user,
  changed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX tenant_config_history_tenant ON public.tenant_config_history (tenant_id, changed_at DESC);

-- Deny-by-default like every other table (0032 default privileges cover grants).
ALTER TABLE public.tenant_config_history ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.tenant_config_audit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    INSERT INTO public.tenant_config_history (tenant_id, op, config)
    VALUES (OLD.tenant_id, TG_OP, to_jsonb(OLD));
    RETURN OLD;
  END IF;
  -- Skip no-op UPDATEs (e.g. touch-only writes) so history stays signal.
  IF TG_OP = 'UPDATE' AND to_jsonb(OLD) = to_jsonb(NEW) THEN
    RETURN NEW;
  END IF;
  INSERT INTO public.tenant_config_history (tenant_id, op, config)
  VALUES (NEW.tenant_id, TG_OP, to_jsonb(NEW));
  RETURN NEW;
END;
$$;

-- Nobody calls this directly; it exists only as a trigger.
REVOKE ALL ON FUNCTION public.tenant_config_audit() FROM public, anon, authenticated;

CREATE TRIGGER tenant_config_audit
  AFTER INSERT OR UPDATE OR DELETE ON public.tenant_config
  FOR EACH ROW EXECUTE FUNCTION public.tenant_config_audit();

-- Baseline: snapshot every EXISTING tenant so history starts from current
-- state, not from the next edit.
INSERT INTO public.tenant_config_history (tenant_id, op, config)
SELECT tenant_id, 'INSERT', to_jsonb(tc) FROM public.tenant_config tc;
