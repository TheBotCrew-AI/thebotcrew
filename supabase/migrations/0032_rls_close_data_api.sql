-- ============================================================
-- Migration 0032 — cerrar la Data API pública (RLS deny-by-default)
-- The Bot Crew · Agent Platform
--
-- Supabase otorga por default a `anon` / `authenticated` permisos completos
-- sobre toda tabla en `public`, y expone PostgREST a internet. Sin RLS ese
-- GRANT se aplica literal: cualquiera con la anon key lee y escribe.
--
-- Convención del repo (ver 0004 / 0005 / 0006): RLS activado + CERO políticas
-- = deny-by-default. El Worker usa la service-role key, que brinca RLS, así
-- que ninguna ruta del runtime cambia. Políticas para el dashboard, después.
--
-- Cubre tres agujeros:
--   1. Seis tablas sin RLS (appointments, bot_events, follow_ups, clients,
--      human_agents, n8n_chat_histories).
--   2. Las vistas de reporting bypasean el RLS de sus tablas base: son de
--      `postgres` y sin `security_invoker` corren con permisos del dueño.
--   3. Los RPC `app_*` son SECURITY INVOKER pero `anon` tiene EXECUTE.
-- ============================================================

-- ------------------------------------------------------------
-- 1. RLS deny-by-default en las tablas restantes.
-- ------------------------------------------------------------
alter table clients      enable row level security;
alter table appointments enable row level security;
alter table bot_events   enable row level security;
alter table human_agents enable row level security;
alter table follow_ups   enable row level security;

-- n8n_chat_histories: artefacto de la época de n8n, creado a mano en prod y
-- nunca migrado, así que en local no existe (un `alter table` pelón rompería
-- `supabase db reset`). Guarda 3 conversaciones con teléfonos como session_id:
-- PII, y hasta hoy legible por `anon`. Se tapa; borrarla es decisión aparte.
do $$
begin
  if to_regclass('public.n8n_chat_histories') is not null then
    execute 'alter table public.n8n_chat_histories enable row level security';
  end if;
end $$;

-- ------------------------------------------------------------
-- 2. Vistas de reporting. `security_invoker = on` las hace respetar el RLS
--    de conversations / messages / appointments en vez de bypasearlo (esto
--    corrige el supuesto de 0005, que las dejó como definer a propósito).
--    Además se les quita el acceso vía Data API: se consultan con `postgres`
--    (SQL editor), que no pasa por PostgREST.
-- ------------------------------------------------------------
alter view public.client_summary    set (security_invoker = on);
alter view public.monthly_activity  set (security_invoker = on);

revoke all on public.client_summary   from anon, authenticated;
revoke all on public.monthly_activity from anon, authenticated;

-- ------------------------------------------------------------
-- 3. Los RPC son transporte interno del Worker (service_role). Nadie más
--    debe poder invocarlos. Defensa en profundidad: aunque el RLS ya niega
--    las filas, esto niega la llamada.
--
--    Hay que revocar de PUBLIC, no sólo de anon/authenticated: Postgres da
--    EXECUTE a PUBLIC por default (el `=X/postgres` del proacl), y ese grant
--    sobrevive a un `revoke ... from anon`. El grant explícito de service_role
--    (`service_role=X/postgres`) NO se ve afectado, pero lo re-otorgamos
--    explícito para que futuras funciones no dependan del default de PUBLIC.
-- ------------------------------------------------------------
do $$
declare fn record;
begin
  for fn in
    select p.oid::regprocedure as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'app\_%'
  loop
    execute format('revoke all on function %s from public, anon, authenticated', fn.sig);
    execute format('grant execute on function %s to service_role', fn.sig);
  end loop;
end $$;

-- ------------------------------------------------------------
-- 4. Default privileges: sin esto, la PRÓXIMA tabla o función creada en
--    `public` vuelve a nacer con GRANT a anon/authenticated y el agujero
--    se reabre en silencio.
-- ------------------------------------------------------------
alter default privileges in schema public revoke all on tables    from anon, authenticated;
alter default privileges in schema public revoke all on functions from anon, authenticated;
