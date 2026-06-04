# database

Schema y migraciones de The Bot Crew — gestionado con Supabase + GitHub.

## Estructura

```
database/
├── migrations/   ← un archivo por cambio, nunca se editan una vez pusheados
│   └── 0001_init.sql
└── seed/         ← datos iniciales / de prueba
    └── clients.sql
```

## Convención de migrations

Cada archivo sigue el patrón `{número}_{descripción}.sql`:

```
0001_init.sql
0002_add_campaigns_table.sql
0003_add_lead_score_to_conversations.sql
```

**Reglas:**
- Nunca edites un migration ya pusheado a `main` — crea uno nuevo
- Usa `if not exists` / `or replace` para que sean idempotentes
- Un migration = un cambio lógico (no mezcles cosas no relacionadas)
- Descripción en snake_case, concisa

## Cómo agregar un cambio

1. Crea `database/migrations/XXXX_descripcion.sql`
2. Escribe el SQL con `if not exists` donde aplique
3. Prueba localmente si puedes, luego push a `main`
4. Supabase detecta el cambio y lo aplica automáticamente

## Cómo correr el seed

En el SQL Editor de Supabase, ejecuta `seed/clients.sql` después del init.
El seed usa `on conflict do nothing` — es seguro correrlo múltiples veces.
