-- ============================================================
-- Seed — clientes iniciales
-- Ejecutar DESPUÉS de 0001_init.sql
-- ============================================================

insert into clients (name, niche, country) values
  ('Médica Center Fem',  'clinic', 'MX'),
  ('Cliente Demo',       'clinic', 'MX')
on conflict do nothing;
