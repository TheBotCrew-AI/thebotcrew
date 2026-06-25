-- Drop the old 12-param version of app_log_message left over from migration 0005.
-- The new 13-param version (with p_ghl_message_id DEFAULT NULL) supersedes it.
-- Without this, Postgres throws "could not choose the best candidate function"
-- when calling the RPC without the optional p_ghl_message_id param.
DROP FUNCTION IF EXISTS public.app_log_message(
  text, uuid, text, text, text, text, text, text, text, uuid, text, timestamptz
);
