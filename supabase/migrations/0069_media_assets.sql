-- ============================================================
-- Migration 0069 — media_assets: the files a follow-up can deliver
-- The Bot Crew · Agent Platform
--
-- A playbook angle (0068) may name an ASSET SLOT ("botox-precios",
-- "laser-que-esperar", "consultorio"…) instead of being text only. This table
-- maps a tenant's slots to the file the nudge sends with its message. A slot
-- with no row (or no row for that treatment) degrades to a text angle, so a
-- tenant onboarded before it has any files runs the same playbook unchanged.
--
-- Rows are written by hand (operator SQL) and READ by the Worker with the
-- service-role key — no RPC, same as tenant_config. One file per
-- (client, slot, interest); `interest` NULL = any treatment, and a treatment
-- row wins over the generic one at send time.
--
-- Delivery per channel (spike 2026-10-12): WhatsApp takes image + document via
-- the `whatsapp.media` object, Facebook takes both via `attachments`, Instagram
-- takes images only — the Worker filters, the table does not.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.media_assets (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id  uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  slot       text NOT NULL CHECK (slot ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  kind       text NOT NULL CHECK (kind IN ('image', 'document')),
  url        text NOT NULL CHECK (url ~ '^https://'),
  name       text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  interest   text,
  active     boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.media_assets IS
  'Files a playbook angle can deliver (0069): one per (client, slot, interest). url must be a direct public URL (no redirect) — GHL''s media library works. name = the filename the lead sees.';
COMMENT ON COLUMN public.media_assets.slot IS
  'The slot a playbook angle names in {"asset": "<slot>", "text": "…"} — kebab-case.';
COMMENT ON COLUMN public.media_assets.interest IS
  'services[].name this file is specific to; NULL = any treatment. A treatment row wins over the NULL row.';

CREATE UNIQUE INDEX IF NOT EXISTS media_assets_client_slot_interest_key
  ON public.media_assets (client_id, slot, COALESCE(interest, ''));

CREATE INDEX IF NOT EXISTS idx_media_assets_client_active
  ON public.media_assets (client_id) WHERE active;

-- Deny-by-default, same as every table in public (0032).
ALTER TABLE public.media_assets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.media_assets FROM anon, authenticated;
