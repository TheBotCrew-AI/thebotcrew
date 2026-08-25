-- ============================================================
-- Test — 0055: la llave del reporte se genera sola, por tenant, y es única.
--
--   psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
--     -v ON_ERROR_STOP=1 -f supabase/tests/0055_report_key.test.sql
--
-- Corre dentro de una transacción y hace ROLLBACK: no deja rastro.
-- ============================================================

\set ON_ERROR_STOP on
BEGIN;

DO $$
DECLARE
  v_tenant uuid;
  v_key    text;
  v_client uuid;
  v_t2     uuid;
  v_key2   text;
BEGIN
  SELECT tc.tenant_id, tc.report_key INTO v_tenant, v_key
  FROM public.tenant_config tc LIMIT 1;
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'no hay tenants sembrados — corre `supabase db reset` primero';
  END IF;

  -- el tenant sembrado (anterior a la migración) recibió su llave en el backfill
  ASSERT v_key ~ '^[0-9a-f]{32}$', format('la llave debe ser 32 hex, es %s', v_key);

  -- un tenant nuevo recibe la suya por default, distinta
  SELECT client_id INTO v_client FROM public.tenants WHERE id = v_tenant;
  INSERT INTO public.tenants (id, client_id, ghl_location_id, is_active)
  VALUES (gen_random_uuid(), v_client, 'loc_test_0055', true) RETURNING id INTO v_t2;
  INSERT INTO public.tenant_config (tenant_id, business_name, timezone)
  VALUES (v_t2, 'Test 0055', 'America/Tijuana');
  SELECT report_key INTO v_key2 FROM public.tenant_config WHERE tenant_id = v_t2;
  ASSERT v_key2 ~ '^[0-9a-f]{32}$' AND v_key2 <> v_key, 'el tenant nuevo debe tener su propia llave';

  -- rotar es un UPDATE
  UPDATE public.tenant_config SET report_key = encode(gen_random_bytes(16), 'hex') WHERE tenant_id = v_t2;
  SELECT report_key INTO v_key FROM public.tenant_config WHERE tenant_id = v_t2;
  ASSERT v_key <> v_key2, 'rotar debe cambiar la llave';

  RAISE NOTICE '0055 ok';
END $$;

ROLLBACK;
