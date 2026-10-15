-- ============================================================
-- Migration 0073 — segment tags: `prefijo:valor`, catalogs, no-promos
-- The Bot Crew · Agent Platform
--
-- The GHL tags the bot writes for segmentation move to a `prefix:value` scheme
-- (lowercase, no accents, dashes), matching the funnel tags the client's own GHL
-- workflows write (`paciente:`, `cotizo:`, `agendo:`, `noshow:`, `valorado`,
-- `fuente:`). Those funnel tags are NEVER written here — only read, as the lead's
-- memory for the front-desk agent.
--
-- What this adds, all expand-only (the deployed Worker ignores every column):
--
--   tenant_config.segment_tags       bool   — the switch for zone/objection tags.
--                                             Supersedes `interest_tags`, which stays
--                                             as an alias (either flag = interest on).
--   tenant_config.zone_catalog       jsonb  — [{slug,label,hints[]}]: the zones the
--   tenant_config.objection_catalog  jsonb    classifier may name. A person extends
--                                             them after reviewing the `otro` notes;
--                                             the system never grows a catalog.
--   conversations.no_promos          bool   — mirrors the `no-promos` contact tag:
--                                             the lead said no to promotions. The
--                                             follow-up runner skips these rows. Set
--                                             AND cleared from the tag webhook (unlike
--                                             `marketing_opted_out_at`, the write-once
--                                             date, which `no-promos` also stamps).
--
-- The interest prefix is NOT a column: `interes:` is the platform default (ghl/tags.ts).
-- The only tenant with interest tags on is Dr. Heriberto Valdivia, whose GHL catalog
-- already uses `interes:botox` / `interes:laser-co2`; his old `interes-*` tags stay on
-- the contacts that carry them. A service whose name slugs differently from the GHL
-- catalog carries `services[].tagSlug` (jsonb, no column) — seeded below for his laser.
--
-- ROLLBACK: drop the four columns and `app_set_no_promos_by_contact`; restore the
-- 0072 bot_events CHECK. The seeded catalogs and tagSlug are data, harmless to leave.
-- ============================================================

ALTER TABLE public.tenant_config
  ADD COLUMN IF NOT EXISTS segment_tags boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS zone_catalog jsonb,
  ADD COLUMN IF NOT EXISTS objection_catalog jsonb;

COMMENT ON COLUMN public.tenant_config.segment_tags IS
  'Segment tags (0073): the status classifier also names the zones the lead mentioned and the objection they gave, written as `zona:<slug>` / `objecion:<slug>` on the GHL contact, validated against zone_catalog / objection_catalog. Also turns interest tags on (interest_tags stays as an alias).';
COMMENT ON COLUMN public.tenant_config.zone_catalog IS
  'Segment tags (0073): [{slug, label, hints[]}]. The closed list of zones the classifier may pick; `hints` are the synonyms the prompt lists. Anything else maps to `otro` + a contact note. Extended by a person (scripts/segment-catalog.mjs), never by the system.';
COMMENT ON COLUMN public.tenant_config.objection_catalog IS
  'Segment tags (0073): [{slug, label, hints[]}]. The closed list of objections (a reason given for NOT booking this turn). Same rules as zone_catalog.';

ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS no_promos boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.conversations.no_promos IS
  'Mirror of the GHL `no-promos` contact tag (0073): the lead does not want promotions. Set and cleared by the tag webhook (presence = true). The follow-up runner skips a conversation with it. Written by the bot on opted_out and by the flagNoPromos tool; removing `bot-opted-out` does NOT remove it.';

-- ------------------------------------------------------------
-- Contact-scoped switch, both directions — the shape of `app_set_bot_off_by_contact`.
-- Returns how many rows changed; 0 on the repeat webhooks (GHL sends the full tag
-- list on ANY tag edit), which is what keeps this loop-free.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.app_set_no_promos_by_contact(p_ghl_contact_id text, p_on boolean)
RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
  v_count int;
BEGIN
  UPDATE public.conversations
     SET no_promos = p_on
   WHERE ghl_contact_id = p_ghl_contact_id
     AND no_promos IS DISTINCT FROM p_on;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.app_set_no_promos_by_contact(text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_set_no_promos_by_contact(text, boolean) TO service_role;

-- ------------------------------------------------------------
-- New event types. Migration FIRST, Worker after: the CHECK rejects an unknown
-- type and `logBotEvent` swallows the error, so the log just goes mute.
-- ------------------------------------------------------------
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
    'capi_event_sent', 'capi_error',
    'reactivation_exhausted', 'pending_info',
    'resume_skipped',
    'pending_info_escalated', 'info_gap_error',
    'interest_tagged',
    'turn_answered',
    'hold_created', 'hold_released', 'hold_expired', 'booking_paid', 'booking_paid_late',
    'payment_error', 'hold_reminder_sent',
    'prime_time_released',
    'stage_changed',
    'courtesy_skipped',
    'variant_expired',
    'zone_tagged', 'objection_tagged', 'segment_note_added',
    'no_promos_on', 'no_promos_off'
  ]));

-- ------------------------------------------------------------
-- Seed for Dr. Heriberto Valdivia (no-op on a local DB without his row). The
-- catalogs are the starting lists agreed 2026-10-14; `otro` is implicit — the
-- classifier falls back to it, so it is not an entry. The laser's GHL tag is
-- `interes:laser-co2`, not what "Láser CO₂ Fraccionado" slugs to.
-- ------------------------------------------------------------
UPDATE public.tenant_config
   SET segment_tags = true,
       zone_catalog = '[
         {"slug":"frente","label":"frente","hints":["líneas de la frente","arrugas de expresión arriba"]},
         {"slug":"entrecejo","label":"entrecejo","hints":["el 11","ceño fruncido","líneas entre las cejas"]},
         {"slug":"patas-de-gallo","label":"patas de gallo","hints":["líneas al lado de los ojos","arrugas al sonreír"]},
         {"slug":"cuello-bandas","label":"bandas del cuello","hints":["cuello","cordones del cuello","platisma"]},
         {"slug":"labios","label":"labios","hints":["boca","volumen de labios","código de barras"]},
         {"slug":"ojeras","label":"ojeras","hints":["bolsas","surco de la lágrima","ojos cansados"]},
         {"slug":"pomulos","label":"pómulos","hints":["mejillas","volumen en las mejillas"]},
         {"slug":"menton","label":"mentón","hints":["barbilla","perfil"]},
         {"slug":"mandibula","label":"mandíbula","hints":["línea mandibular","papada","contorno"]},
         {"slug":"surco-nasogeniano","label":"surco nasogeniano","hints":["líneas de la nariz a la boca","paréntesis"]},
         {"slug":"lineas-marioneta","label":"líneas de marioneta","hints":["líneas de la boca hacia abajo","comisuras caídas"]},
         {"slug":"nariz","label":"nariz","hints":["rinomodelación","perfil de la nariz"]},
         {"slug":"cicatrices-acne","label":"cicatrices de acné","hints":["marcas de acné","hoyitos"]},
         {"slug":"manchas","label":"manchas","hints":["paño","melasma","pigmentación"]},
         {"slug":"poros","label":"poros","hints":["poros abiertos","poros dilatados"]},
         {"slug":"textura","label":"textura","hints":["piel apagada","piel áspera","luminosidad"]},
         {"slug":"flacidez","label":"flacidez","hints":["piel caída","falta de firmeza","descolgamiento"]},
         {"slug":"estrias","label":"estrías","hints":[]},
         {"slug":"sudoracion","label":"sudoración","hints":["hiperhidrosis","sudor en axilas","sudor en manos"]},
         {"slug":"bruxismo","label":"bruxismo","hints":["aprieto los dientes","rechinar los dientes","dolor de mandíbula"]},
         {"slug":"sonrisa-gingival","label":"sonrisa gingival","hints":["se me ve la encía al sonreír"]}
       ]'::jsonb,
       objection_catalog = '[
         {"slug":"precio","label":"precio","hints":["está caro","no me alcanza","muy costoso","presupuesto"]},
         {"slug":"miedo-dolor","label":"miedo al dolor","hints":["duele","me da miedo la aguja","agujas"]},
         {"slug":"miedo-resultado","label":"miedo al resultado","hints":["se nota","queda artificial","cara congelada","quedar mal"]},
         {"slug":"tiempo","label":"tiempo","hints":["no tengo tiempo","trabajo","ando ocupada","no puedo esta semana"]},
         {"slug":"lo-pensara","label":"lo pensará","hints":["lo pienso","después te digo","luego","déjame ver"]},
         {"slug":"pareja-familia","label":"pareja o familia","hints":["le pregunto a mi esposo","mi mamá","consultarlo en casa"]}
       ]'::jsonb,
       services = (
         SELECT jsonb_agg(
           CASE WHEN s->>'name' = 'Láser CO₂ Fraccionado' THEN s || '{"tagSlug":"laser-co2"}'::jsonb ELSE s END
         )
         FROM jsonb_array_elements(services) s
       )
 WHERE business_name = 'Dr. Heriberto Valdivia'
   AND jsonb_typeof(services) = 'array';
