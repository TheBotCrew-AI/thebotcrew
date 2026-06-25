-- Expand conversations_status_check to include statuses introduced by the
-- qualification flow: standby (lead doesn't qualify), opted_out (explicit
-- opt-out), completed (lead registered/finished).
ALTER TABLE public.conversations
  DROP CONSTRAINT conversations_status_check;

ALTER TABLE public.conversations
  ADD CONSTRAINT conversations_status_check
  CHECK (status = ANY (ARRAY['active', 'closed', 'handed_off', 'standby', 'opted_out', 'completed']));
