-- ============================================================
-- Migration 0033 — key de IA por tenant + contabilidad de tokens
-- The Bot Crew · Agent Platform
--
-- Dos piezas de un mismo objetivo: saber cuánto cuesta CADA cliente.
--
-- 1. `tenant_config.ai_key_ref` — puntero (slug) al Worker secret que guarda la
--    key de ese tenant. NO guarda la key: el material secreto sigue viviendo solo
--    en los secrets de Cloudflare (regla de CLAUDE.md "keys never touch the DB").
--    El runtime resuelve OPENAI_API_KEY__<SLUG> / ANTHROPIC_API_KEY__<SLUG>.
--    NULL = usa la key de plataforma. Si el secret falta, el runtime CAE a la key
--    de plataforma y registra un bot_event `ai_key_fallback` — quedarse mudo por
--    una key mal puesta es peor que una factura mal atribuida.
--
-- 2. `llm_usage` — un renglón por llamada al modelo, con tokens de entrada/salida.
--    El dashboard de OpenAI da totales diarios por proyecto; esto da costo por
--    conversación, por rol y por lead, que es el número con el que se fija precio.
--    Cubre las 4 llamadas que hace un turno: el agente, el clasificador de estado,
--    la extracción de nombre, y el follow-up de reactivación.
--
-- 3. `model_pricing` — precios por millón de tokens. SE CREA VACÍA a propósito:
--    los precios los llena Leo desde la página de OpenAI. Sin renglón de precio la
--    vista reporta tokens con costo NULL en vez de inventar un número.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Puntero a la key por tenant (nunca la key).
-- ------------------------------------------------------------
alter table tenant_config
  add column if not exists ai_key_ref text;

comment on column tenant_config.ai_key_ref is
  'Slug del Worker secret con la key de IA de este tenant (p.ej. ''MADI'' → OPENAI_API_KEY__MADI). NUNCA la key en sí. NULL = key de plataforma.';

-- ------------------------------------------------------------
-- 2. Contabilidad de tokens.
-- ------------------------------------------------------------
create table if not exists llm_usage (
  id              uuid primary key default gen_random_uuid(),
  client_id       uuid not null references clients(id) on delete cascade,
  conversation_id uuid references conversations(id) on delete set null,
  -- Qué llamada fue: 'front-desk' | 'reactivation' | 'classify' | 'extract-name'.
  -- Texto libre a propósito: agregar una llamada auxiliar no debe requerir migración.
  call_kind       text not null,
  provider        text not null,
  model           text not null,
  input_tokens    int  not null default 0,
  output_tokens   int  not null default 0,
  -- Entrada cacheada: se cobra distinto, y sin separarla el costo sale inflado.
  cached_input_tokens int not null default 0,
  -- De qué secret salió la key ('platform' o el slug del tenant). Cierra el loop:
  -- deja verificar que el gasto de un cliente cayó en SU key y no en la de plataforma.
  key_source      text,
  created_at      timestamptz not null default now()
);

create index if not exists idx_llm_usage_client_created on llm_usage(client_id, created_at desc);
create index if not exists idx_llm_usage_conversation   on llm_usage(conversation_id);

alter table llm_usage enable row level security;  -- deny-by-default (convención 0032)

-- ------------------------------------------------------------
-- 3. Precios por modelo. Vacía: llenar con los precios reales de cada proveedor.
--    `effective_from` permite que un cambio de precio no reescriba el histórico.
-- ------------------------------------------------------------
create table if not exists model_pricing (
  model                  text        not null,
  effective_from         timestamptz not null default now(),
  input_usd_per_1m       numeric(12,4) not null,
  output_usd_per_1m      numeric(12,4) not null,
  cached_input_usd_per_1m numeric(12,4),
  primary key (model, effective_from)
);

comment on table model_pricing is
  'Precios por millón de tokens. Se llena a mano desde la página de precios del proveedor. Sin renglón vigente, llm_cost_monthly reporta tokens con costo NULL (nunca un precio inventado).';

alter table model_pricing enable row level security;  -- deny-by-default

-- ------------------------------------------------------------
-- 4. RPC de escritura. SECURITY INVOKER (default) + grant explícito a
--    service_role, igual que el resto de los app_*.
--    Resuelve la conversación por su id de GHL, como app_log_event.
-- ------------------------------------------------------------
create or replace function app_log_llm_usage(
  p_client_id           uuid,
  p_ghl_conversation_id text,
  p_call_kind           text,
  p_provider            text,
  p_model               text,
  p_input_tokens        int,
  p_output_tokens       int,
  p_cached_input_tokens int,
  p_key_source          text
) returns uuid
language plpgsql
as $$
declare
  v_conv_id  uuid;
  v_usage_id uuid;
begin
  if p_ghl_conversation_id is not null then
    select id into v_conv_id
    from conversations
    where ghl_conversation_id = p_ghl_conversation_id
    limit 1;
  end if;

  insert into llm_usage (
    client_id, conversation_id, call_kind, provider, model,
    input_tokens, output_tokens, cached_input_tokens, key_source
  ) values (
    p_client_id, v_conv_id, p_call_kind, p_provider, p_model,
    coalesce(p_input_tokens, 0), coalesce(p_output_tokens, 0),
    coalesce(p_cached_input_tokens, 0), p_key_source
  )
  returning id into v_usage_id;

  return v_usage_id;
end;
$$;

revoke all on function app_log_llm_usage(uuid, text, text, text, text, int, int, int, text)
  from public, anon, authenticated;
grant execute on function app_log_llm_usage(uuid, text, text, text, text, int, int, int, text)
  to service_role;

-- ------------------------------------------------------------
-- 5. Vista de reporte: tokens y costo por cliente / mes / modelo.
--    security_invoker = on + revocada de la Data API (convención 0032: una vista
--    definer bypasea el RLS de sus tablas base).
--    El precio se toma del renglón vigente AL MOMENTO del consumo, no el de hoy.
-- ------------------------------------------------------------
create or replace view llm_cost_monthly as
select
  u.client_id,
  c.name                                   as client_name,
  date_trunc('month', u.created_at)        as month,
  u.model,
  u.call_kind,
  count(*)                                 as calls,
  sum(u.input_tokens)                      as input_tokens,
  sum(u.cached_input_tokens)               as cached_input_tokens,
  sum(u.output_tokens)                     as output_tokens,
  -- NULL cuando falta el precio del modelo: sin dato preferimos un hueco visible
  -- a un número inventado.
  round(sum(
    (u.input_tokens  - u.cached_input_tokens) / 1e6 * p.input_usd_per_1m
    + u.cached_input_tokens / 1e6 * coalesce(p.cached_input_usd_per_1m, p.input_usd_per_1m)
    + u.output_tokens / 1e6 * p.output_usd_per_1m
  )::numeric, 4)                           as cost_usd
from llm_usage u
join clients c on c.id = u.client_id
left join lateral (
  select mp.input_usd_per_1m, mp.output_usd_per_1m, mp.cached_input_usd_per_1m
  from model_pricing mp
  where mp.model = u.model
    and mp.effective_from <= u.created_at
  order by mp.effective_from desc
  limit 1
) p on true
group by u.client_id, c.name, date_trunc('month', u.created_at), u.model, u.call_kind;

alter view llm_cost_monthly set (security_invoker = on);
revoke all on llm_cost_monthly from anon, authenticated;

-- ------------------------------------------------------------
-- 6. Nuevo evento: el tenant tenía ai_key_ref pero su secret no existe y se usó
--    la key de plataforma. Sin esto el fallback sería silencioso y la atribución
--    se degradaría sin que nadie se entere.
-- ------------------------------------------------------------
ALTER TABLE public.bot_events DROP CONSTRAINT IF EXISTS bot_events_event_type_check;
ALTER TABLE public.bot_events ADD CONSTRAINT bot_events_event_type_check
  CHECK (event_type = ANY (ARRAY[
    'lead_qualified', 'follow_up_sent', 'no_show_recovered', 'out_of_hours_handled',
    'objection_handled', 'reactivation_sent', 'agent_error', 'db_error', 'delivery_error',
    'run_superseded', 'run_suppressed', 'handoff_tag_on', 'handoff_tag_off',
    'channel_disabled', 'test_mode_skip', 'keyword_required', 'bot_activated',
    'availability_checked', 'booking_failed', 'status_changed', 'turn_scheduled',
    'demo_toggled', 'ai_key_fallback'
  ]));
