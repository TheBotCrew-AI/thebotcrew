-- ============================================================
-- Migration 0041 — demo ends when the lead books
-- The Bot Crew · Agent Platform
--
-- A simulated booking IS the demo's objective. Letting the conversation carry
-- on afterwards ("¿algo más?") wastes the strongest moment of the whole funnel:
-- the lead has just watched an assistant book them in under a minute. So the
-- session now ends the instant bookAppointment succeeds in demo mode, and the
-- handover pitch lands right on top of the confirmation.
--
-- New end_reason: 'booked' — distinct from 'exhausted' (ran out of messages)
-- because it's the strongest intent signal we record, and it should be
-- reportable on its own (demo → booked conversion).
--
-- ROLLBACK: restore the 0038 CHECK constraint. Any 'booked' rows written by the
-- newer code would violate it, so clear or remap them first
-- (update demo_sessions set end_reason='exhausted' where end_reason='booked').
-- ============================================================

ALTER TABLE public.demo_sessions DROP CONSTRAINT IF EXISTS demo_sessions_end_reason_check;
ALTER TABLE public.demo_sessions ADD CONSTRAINT demo_sessions_end_reason_check
  CHECK (end_reason IS NULL OR end_reason = ANY (ARRAY['exhausted', 'expired', 'closed', 'replaced', 'booked']));
