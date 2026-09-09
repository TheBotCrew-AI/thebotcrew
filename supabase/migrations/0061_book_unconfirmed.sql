-- ============================================================
-- Migration 0061 — book appointments as "No confirmada" (per tenant)
-- The Bot Crew · Agent Platform
--
-- Until now every booking the bot made was born `appointmentStatus: 'confirmed'`
-- (hardcoded in ghl/client.ts), so GHL's calendar could not tell apart a slot the
-- lead merely accepted in chat from one they confirmed they'll attend. A tenant
-- running a confirmation sequence (Heriberto's CONFIRMO workflows) wants the
-- opposite: the bot books as `new` — "No confirmada" in the GHL UI — and the
-- reminder workflow flips it to `confirmed` when the patient replies. The status
-- becomes the real state, visible on the calendar and usable as a workflow filter,
-- instead of a tag standing in for it.
--
-- Per tenant: book_unconfirmed. Default FALSE — a tenant with no confirmation
-- sequence would just accumulate appointments nobody ever confirms, and any of
-- their GHL workflows filtering on "Confirmed" would quietly stop firing.
--
-- Scope: bookAppointment and rescheduleAppointment (a moved cita is unconfirmed
-- again — otherwise reagendar would confirm it on the lead's behalf). cancelAppointment
-- is untouched: 'cancelled' is 'cancelled'.
--
-- Nothing in our own code reads appointment status except to exclude 'cancelled'
-- (resolve-appointment, lookup-appointment, db/upcoming-appointment), so an
-- unconfirmed cita still reschedules, cancels, gates nudges and switches the prompt
-- into modo asistencia exactly like a confirmed one.
--
-- Expand-only: the deployed Worker doesn't read the column.
-- ============================================================

ALTER TABLE public.tenant_config
  ADD COLUMN IF NOT EXISTS book_unconfirmed boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.tenant_config.book_unconfirmed IS
  'Book/reschedule GHL appointments as appointmentStatus=new ("No confirmada") instead of confirmed, so a GHL confirmation workflow owns the flip to confirmed. false = book confirmed (default).';
