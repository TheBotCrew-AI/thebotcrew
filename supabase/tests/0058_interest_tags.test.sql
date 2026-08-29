-- ============================================================
-- Test — 0058: interest_tags nace apagado y el evento interest_tagged es válido.
--
-- Lo primero protege a los tenants que ya existen: la columna llega con default
-- false, así que ningún contacto de MADI ni de The Bot Crew recibe tags nuevos por
-- aplicar la migración. Lo segundo es el CHECK de bot_events: si el tipo nuevo no
-- está en la lista, el Worker escribe el evento, la DB lo rechaza y el log queda
-- mudo — la clase de falla silenciosa que test:unit no puede ver.
--
--   psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
--     -v ON_ERROR_STOP=1 -f supabase/tests/0058_interest_tags.test.sql
--
-- Corre dentro de una transacción y hace ROLLBACK: no deja rastro.
-- ============================================================

\set ON_ERROR_STOP on
BEGIN;

DO $$
DECLARE
  v_client uuid;
BEGIN
  SELECT id INTO v_client FROM public.clients LIMIT 1;
  IF v_client IS NULL THEN
    RAISE EXCEPTION 'no hay clients sembrados — corre `supabase db reset` primero';
  END IF;

  -- ---------- 1. la columna existe y nace false ----------
  ASSERT (SELECT bool_and(NOT interest_tags) FROM public.tenant_config),
    'interest_tags debe nacer false: etiquetar contactos de un cliente sin pedirlo es un cambio de comportamiento';

  -- ---------- 2. el evento nuevo pasa el CHECK ----------
  INSERT INTO public.bot_events (client_id, event_type, metadata)
  VALUES (v_client, 'interest_tagged', '{"service":"Botox","tag":"interes-botox"}'::jsonb);

  -- ---------- 3. un tipo inventado sigue rechazado (el CHECK sigue vivo) ----------
  BEGIN
    INSERT INTO public.bot_events (client_id, event_type, metadata)
    VALUES (v_client, 'not_a_real_event', '{}'::jsonb);
    RAISE EXCEPTION 'el CHECK de event_type dejó pasar un tipo inventado';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;

  RAISE NOTICE '0058 ok';
END $$;

ROLLBACK;
