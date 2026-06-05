-- ============================================================
-- Seed — demo tenant + config (agent runtime)
-- Run AFTER 0001_init.sql, clients.sql, 0004, 0005.
-- Links a demo GHL location to the existing "Cliente Demo" client so the
-- local end-to-end webhook simulation resolves a tenant and runs the agent.
--
-- The webhook fixture (workers/fixtures/ghl-inbound.example.json) uses
-- locationId = 'loc_demo_0001'.
-- ============================================================

-- Tenant: maps GHL location 'loc_demo_0001' -> "Cliente Demo"
insert into tenants (client_id, ghl_location_id, ghl_token_ref, is_active)
select c.id, 'loc_demo_0001', 'GHL_API_TOKEN', true
from clients c
where c.name = 'Cliente Demo'
on conflict (ghl_location_id) do nothing;

-- Config for that tenant.
insert into tenant_config (
  tenant_id, business_name, timezone, tone, services, hours, calendars, faq, enabled_roles
)
select
  t.id,
  'Clínica Demo',
  'America/Mexico_City',
  'cálido, profesional y cercano',
  '[
    { "name": "Consulta general", "durationMin": 30, "description": "Primera valoración con el especialista" },
    { "name": "Limpieza dental",  "durationMin": 45, "description": "Profilaxis e higiene dental" }
  ]'::jsonb,
  '{
    "mon": [{ "open": "09:00", "close": "18:00" }],
    "tue": [{ "open": "09:00", "close": "18:00" }],
    "wed": [{ "open": "09:00", "close": "18:00" }],
    "thu": [{ "open": "09:00", "close": "18:00" }],
    "fri": [{ "open": "09:00", "close": "15:00" }]
  }'::jsonb,
  '{
    "Consulta general": "cal_demo_general",
    "Limpieza dental":  "cal_demo_limpieza"
  }'::jsonb,
  '[
    { "q": "¿Dónde están ubicados?", "a": "En el centro de la ciudad; te compartimos la ubicación exacta al agendar." },
    { "q": "¿Aceptan seguro?",       "a": "Trabajamos con las principales aseguradoras; confírmanos la tuya al agendar." }
  ]'::jsonb,
  array['front-desk']
from tenants t
where t.ghl_location_id = 'loc_demo_0001'
on conflict (tenant_id) do nothing;
