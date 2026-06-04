# thebotcrew

Monorepo de The Bot Crew — infraestructura de agentes de IA para negocios en LATAM.

## Estructura

```
thebotcrew/
├── database/     ← Schema y migraciones (Supabase)
├── api/          ← Backend / API (próximamente)
├── workers/      ← Bots y automatizaciones en código (próximamente)
└── dashboard/    ← Stats UI (próximamente)
```

## Stack

- **DB**: Supabase (PostgreSQL)
- **Schema management**: migrations en `database/migrations/`, auto-deploy vía GitHub
- **Orquestación actual**: n8n (migrando a código)
- **Runtime objetivo**: Bun / Node.js

## Base de datos

Ver [`database/README.md`](./database/README.md) para convenciones de migraciones.

### Tablas principales

| Tabla | Descripción |
|---|---|
| `clients` | Clientes de la agencia |
| `conversations` | Hilos de WhatsApp/IG manejados por el bot |
| `appointments` | Citas agendadas, reagendadas o canceladas |
| `messages` | Mensajes individuales (metadata, sin texto) |
| `bot_events` | Eventos de valor: leads calificados, fuera de horario, etc. |

### Views

| View | Descripción |
|---|---|
| `client_summary` | KPIs por cliente: conversaciones, bookings, tasa de conversión |
| `monthly_activity` | Volumen mensual agregado |
