# thebotcrew

Monorepo de The Bot Crew — plataforma multi-tenant de agentes de IA para negocios de
servicios en LATAM. Un solo deploy atiende a todos los clientes; cada cliente usa
GoHighLevel (GHL) como CRM/inbox y nuestros agentes hablan con GHL vía webhooks
(entrada) y la API de GHL (salida, calendario).

> La memoria/arquitectura viva del proyecto está en [`CLAUDE.md`](./CLAUDE.md).

## Estructura

```
thebotcrew/
├── supabase/     ← Schema, migraciones y seeds (Supabase / Postgres)
├── workers/      ← Runtime de agentes: Cloudflare Worker + Mastra (@thebotcrew/workers)
├── api/          ← Backend / API (próximamente)
└── dashboard/    ← Stats UI (próximamente)
```

## Stack

- **Lenguaje**: TypeScript (strict)
- **Framework de agentes**: Mastra
- **Runtime**: Cloudflare Workers (Wrangler para dev/deploy)
- **DB**: Supabase (PostgreSQL); pgvector disponible para RAG futuro
- **CRM**: GHL (webhooks de entrada + API para salida y calendario)
- **Package manager**: pnpm
- **Orquestación**: migrando de n8n a código

## Desarrollo local

```bash
pnpm install
cp workers/.dev.vars.example workers/.env   # llena los secretos (NUNCA al repo)
supabase start && supabase db reset         # aplica migraciones 0001–0005 + seed demo
pnpm dev                                     # mastra dev (Worker + ruta /webhooks/ghl)
pnpm webhook:simulate                        # dispara un webhook GHL de prueba
pnpm typecheck && pnpm eval                  # tipos + evals (offline siempre; live con ANTHROPIC_API_KEY)
```

## Base de datos

Dos capas (ver `supabase/migrations/`):

- **Config (lectura)** — `tenants`, `tenant_config`: variables por cliente (negocio,
  servicios, horarios, calendarios, FAQ, tono, roles habilitados).
- **Conversación / stats (escritura)** — vía RPCs `app_log_*`:

### Tablas principales

| Tabla | Descripción |
|---|---|
| `clients` | Clientes de la agencia |
| `tenants` / `tenant_config` | Mapeo de subcuenta GHL → cliente + su configuración |
| `conversations` | Hilos de WhatsApp/IG manejados por el bot |
| `messages` | Mensajes con **contenido** y atribución (lead / IA-rol / agente humano) |
| `human_agents` | Roster de agentes humanos (colaboración humano ↔ IA) |
| `appointments` | Citas agendadas, reagendadas o canceladas |
| `bot_events` | Eventos de valor: leads calificados, fuera de horario, etc. |

### Views

| View | Descripción |
|---|---|
| `client_summary` | KPIs por cliente: conversaciones, bookings, tasa de conversión |
| `monthly_activity` | Volumen mensual agregado |

Ambas vistas se consultan con el rol `postgres` (SQL editor). Desde la migración 0032 no son
accesibles vía la Data API (`anon` / `authenticated`) y corren con `security_invoker = on`,
o sea que respetan el RLS de sus tablas base en vez de bypasearlo.
