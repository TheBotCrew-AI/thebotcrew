-- ============================================================
-- Test — 0069: media_assets — la forma de la tabla y su llave por ranura.
--
--   psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
--     -v ON_ERROR_STOP=1 -f supabase/tests/0069_media_assets.test.sql
--
-- Corre dentro de una transacción y hace ROLLBACK: no deja rastro.
-- ============================================================

\set ON_ERROR_STOP on
BEGIN;

DO $$
DECLARE
  v_client uuid;
  v_n      int;
  v_failed boolean;
BEGIN
  SELECT t.client_id INTO v_client FROM public.tenants t LIMIT 1;
  IF v_client IS NULL THEN
    RAISE EXCEPTION 'no hay tenants sembrados — corre `supabase db reset` primero';
  END IF;

  -- 1. una ranura genérica y una por tratamiento conviven
  INSERT INTO public.media_assets (client_id, slot, kind, url, name)
  VALUES (v_client, 'precios', 'image', 'https://example.com/precios.png', 'precios.png');
  INSERT INTO public.media_assets (client_id, slot, kind, url, name, interest)
  VALUES (v_client, 'precios', 'document', 'https://example.com/botox.pdf', 'botox.pdf', 'Botox');
  SELECT count(*) INTO v_n FROM public.media_assets WHERE client_id = v_client AND slot = 'precios';
  ASSERT v_n = 2, 'genérica + por tratamiento deben convivir';

  -- 2. la misma ranura genérica dos veces NO
  v_failed := false;
  BEGIN
    INSERT INTO public.media_assets (client_id, slot, kind, url, name)
    VALUES (v_client, 'precios', 'image', 'https://example.com/otro.png', 'otro.png');
  EXCEPTION WHEN unique_violation THEN v_failed := true;
  END;
  ASSERT v_failed, 'una segunda ranura genérica "precios" debió chocar';

  -- 3. kind fuera del catálogo NO
  v_failed := false;
  BEGIN
    INSERT INTO public.media_assets (client_id, slot, kind, url, name)
    VALUES (v_client, 'video-doctor', 'video', 'https://example.com/v.mp4', 'v.mp4');
  EXCEPTION WHEN check_violation THEN v_failed := true;
  END;
  ASSERT v_failed, 'kind=video debió rechazarse (todavía no se entrega)';

  -- 4. ranura con mayúsculas o espacios NO
  v_failed := false;
  BEGIN
    INSERT INTO public.media_assets (client_id, slot, kind, url, name)
    VALUES (v_client, 'Precios Botox', 'image', 'https://example.com/p.png', 'p.png');
  EXCEPTION WHEN check_violation THEN v_failed := true;
  END;
  ASSERT v_failed, 'la ranura debe ser kebab-case';

  -- 5. URL que no sea https NO
  v_failed := false;
  BEGIN
    INSERT INTO public.media_assets (client_id, slot, kind, url, name)
    VALUES (v_client, 'consultorio', 'image', 'http://example.com/c.png', 'c.png');
  EXCEPTION WHEN check_violation THEN v_failed := true;
  END;
  ASSERT v_failed, 'la URL debe ser https';

  -- 6. RLS prendido, sin políticas
  SELECT count(*) INTO v_n FROM pg_policies WHERE schemaname = 'public' AND tablename = 'media_assets';
  ASSERT v_n = 0, 'media_assets no debe tener políticas';
  ASSERT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.media_assets'::regclass), 'RLS debe estar prendido';

  RAISE NOTICE '0069 OK: 6 assertions';
END $$;

ROLLBACK;
