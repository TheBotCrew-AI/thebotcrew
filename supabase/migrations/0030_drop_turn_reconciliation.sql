-- ============================================================
-- Migration 0030 — drop turn reconciliation (DO migration Phase 3 cleanup)
-- The Bot Crew · Agent Platform
--
-- Turns now run through the per-conversation Durable Object (ConversationDO):
-- serialized + a durable 15s Alarm. That closes the double-run and silent-drop
-- classes by construction, so the compensating reconciliation patch from 0020 is
-- redundant. Monitoring (turn_scheduled ≈ front-desk turns, no recovery re-runs)
-- confirmed the DO handles 100% of turns. Removed here:
--   • app_load_unanswered_turns()  — the sweep's RPC (loadUnansweredTurns)
--   • conversations.reconcile_claimed_at — the atomic claim column (claimTurnForProcessing)
-- The messages.ghl_message_id unique dedup stays. See docs/durable-objects-migration.md.
-- ============================================================

DROP FUNCTION IF EXISTS public.app_load_unanswered_turns(int, int, int, int);

ALTER TABLE public.conversations
  DROP COLUMN IF EXISTS reconcile_claimed_at;
