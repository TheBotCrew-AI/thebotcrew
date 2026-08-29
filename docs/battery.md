# Batería de conversaciones de muestra

> Conversaciones de ejemplo para enseñarle a un cliente cómo atiende su asistente, sin tocar
> nada real: el agente corre con la config viva del tenant, contra un GoHighLevel falso, y un
> modelo juega al lead. Salida: transcripciones JSON + "screenshots" de WhatsApp + un reporte
> de una página para el cliente. No es un test — no afirma nada. Los evals son otra cosa
> (`roles/*/evals`, ver CLAUDE.md § Tests & evals).

## Uso en 3 comandos

```bash
cd workers
pnpm battery heriberto                 # corre todos los escenarios del tenant (~1 min c/u)
pnpm battery:render heriberto          # PNGs + galería + reporte
open battery/heriberto/render/reporte.html
```

Opciones:

| Comando | Para qué |
|---|---|
| `pnpm battery <slug> --only id,id` | Correr (o re-correr) solo algunos escenarios |
| `pnpm battery <slug> --lead-model gpt-5-mini` | Lead más barato; el bot siempre corre en el modelo del tenant |
| `pnpm battery:render <slug> --avatar ruta/logo.png` | Foto de perfil del negocio en el chat (se incrusta en el HTML) |
| `pnpm battery:render <slug> --only id` | Re-renderizar uno |
| `pnpm battery:render <slug> --no-png` | Solo HTML (sin navegador) |
| `pnpm battery:publish <slug> --project <nombre>` | Sube `reporte.html` a Vercel (producción) y devuelve la URL |
| `EVAL_MODEL=gpt-5-mini pnpm battery <slug>` | Forzar el modelo del bot (mismo mecanismo que los evals) |

Requisitos: `workers/.env` con `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` (config viva; sin
ellos usa la fixture de evals) y `OPENAI_API_KEY` (o `ANTHROPIC_API_KEY`). Para los PNG hace
falta un `chrome-headless-shell` — ver Problemas.

## Qué sale y qué se manda

```
workers/battery/<slug>/
  <id>.json                 # transcripción — SE COMMITEA (es la evidencia de cómo se comportó ese día)
  render/                   # gitignored, se regenera
    reporte.html            # PARA EL CLIENTE: one-page, un archivo, se abre en el celular
    index.html              # PARA TI: galería con herramientas llamadas, citas, tags, modelo, fuente de config
    <id>.html, <id>-N.png   # screenshots por pantalla (1170×2532), por si quieres mandar fotos sueltas
```

**`reporte.html`** es lo que ve el cliente: una conversación a la vez, deslizando; cada una se
reproduce sola (el lead escribe, "escribiendo…", contesta la asistente), con arriba el escenario
en una línea y en qué terminó (✅ consulta agendada · fecha, 📋 duda enviada al equipo, 💬 solo
pidió información, 🔁 cita cambiada). Cero términos técnicos. Es un solo archivo: se manda por
WhatsApp/correo o se sube a cualquier host estático. `reporte.html#3` abre en la conversación 3.
Trae una nota honesta: los pacientes son simulados, las respuestas son reales, las citas no.

**Publicar:** `pnpm battery:publish heriberto --project sofia-demo-valdivia` →
https://sofia-demo-valdivia.vercel.app (sólo `reporte.html`, como `index.html`; la galería nunca
sale de la máquina). Usa el CLI de Vercel ya logueado (`vercel whoami`); el proyecto se crea solo
la primera vez y cada corrida reemplaza la anterior. Un proyecto por cliente.

**`index.html`** trae lo que el cliente no necesita: cada herramienta que llamó el agente con sus
argumentos, qué quedó en el GHL falso, el modelo, si la config vino de Supabase o de la fixture.

## Cómo funciona (para saber qué prueba y qué no)

- **Bot real, config viva.** `buildFrontDeskAgent()` con `loadTenantConfig(ghlLocationId)` de
  Supabase — el mismo prompt que prod ese día. Reasoning effort, modelo y llave: los de siempre.
- **GHL falso** (`src/battery/fake-ghl.ts`): la disponibilidad se genera del horario real del
  tenant (grid de 30 min, ~35% de slots "ocupados" de forma determinista para que parezca una
  agenda de verdad); agendar quita el slot; cambiar/cancelar lo mueven; los tags y el nombre se
  guardan en memoria. Nada llega a un calendario de verdad.
- **DB falsa**: todas las queries están stubbeadas menos `loadTenantConfig`. Una query que no
  esté en la lista **lanza** ("db query X is not faked") en vez de escribir en prod — si
  aparece, agrega el stub en `battery.eval.ts`.
- **El lead es un modelo** con la persona del escenario. Ve el chat desde su lado, escribe un
  mensaje por turno, elige un horario de los que le ofrecieron, y contesta `[FIN]` cuando su
  objetivo se cumplió o no tiene más que decir.
- **Fin de la conversación**: la primera que ocurra — el bot llamó una herramienta de
  `endWhen.toolCalled` (y el lead recibe `closingTurns` mensajes más, por default 1, para el
  "gracias"), el lead dijo `[FIN]`, o `maxTurns`.
- **La historia se arma como en prod**: cada burbuja del bot es un mensaje `assistant` aparte, y
  antes de cada turno se resuelve `activeAppointment` igual que `runAgentTurn`.
- Lo que NO corre: el clasificador de status, los follow-ups, CAPI, los tags de interés — todo
  lo que vive en `webhook-handler.ts` fuera del `agent.generate`.

Costo: ~6 turnos del agente a effort `high` + ~6 del lead por escenario → centavos por corrida.

## Otro tenant

1. `workers/src/battery/scenarios/<slug>.ts` exportando un `TenantScenarios`:
   `slug`, `ghlLocationId`, `fixture` (el tenant de `evals/fixtures.ts`), `assistantName`
   (como se presenta en el prompt: "Soy Sofía…"), `scenarios`.
2. Regístralo en `scenarios/index.ts`.
3. `pnpm battery <slug>`.

## Escribir un escenario

```ts
{
  id: 'cta-laser-co2-dudas',              // nombre de archivo
  title: 'Anuncio Láser CO₂ — "tengo dudas"',   // lo lee el cliente
  shows: 'Viene con dudas, no con decisión. …', // lo lee el cliente: UNA línea, sin jerga
  lead: { name: 'Rocío', phone: '+526141110002', channel: 'whatsapp', persona: `…` },
  opener: '🤔Me interesa el Láser CO2 Fraccionado, pero tengo dudas',  // fijo: el CTA del anuncio
  script: ['segundo mensaje fijo'],      // opcional, antes de que la persona improvise
  maxTurns: 9,
  endWhen: { toolCalled: ['bookAppointment'] },
  preset: { appointment: { serviceName: 'Consulta', daysAhead: 2, time: '11:00' } }, // ya tiene cita
}
```

Lo que hace buena a una persona:
- **Quién es y qué le duele** (edad, zona, si es primera vez) — el bot pregunta eso y el lead
  debe poder contestar sin inventar.
- **Sus dudas en orden y de una en una** — así se ve el goteo del bot, no un muro.
- **Qué acepta**: "cuando te ofrezcan horarios, eliges uno de la tarde"; "si no hay sábado,
  preguntas lo más tarde entre semana".
- **Cuándo termina**: "cuando te confirmen, agradeces y terminas" / "no agendas aunque insistan".
- Los **CTA reales de las campañas** van como `opener` textual (emoji incluido): es lo que
  llega del anuncio.
- Sin teléfono para leads de IG/FB (`channel: 'instagram'`, sin `phone`) — cambia lo que el
  prompt dice sobre recordatorios.

`title` y `shows` los **lee el cliente**: nada de "flagPendingInfo", "tool", "lead". Los
detalles técnicos van en `index.html` solos.

## Cuándo re-correr

Después de cambiar el prompt/FAQ del tenant, o antes de mandarle algo al cliente. Las
transcripciones commiteadas son la foto de ese día; el diff en git te dice qué cambió en el
comportamiento. Re-correr un escenario que salió raro es legítimo (el modelo es una tasa, no un
switch — ver `prompt-rules-need-repeat-runs`), pero si sale raro 2 de 3 veces, es del prompt,
no de la corrida.

## Problemas

- **`db query "X" is not faked`** — una herramienta nueva usa una query que la batería no
  conoce. Agrega el stub en `vi.mock('../db/queries.js')` de `battery.eval.ts`.
- **Chrome muere a los ~2 s / render "flaky"** — en la Mac de Leo cualquier Chrome headless
  (la app) recibe un SIGTERM externo (verificado 2026-08-29). El render prefiere
  `chrome-headless-shell` del caché de puppeteer/playwright (`findBrowser()` en
  `render-battery.mjs`); si no hay ninguno: `npx @puppeteer/browsers install chrome-headless-shell@stable`,
  o `CHROME_BIN=/ruta`.
- **El bot ofrece un horario absurdo** — revisa `hours` en `tenant_config`; el GHL falso genera
  los slots de ahí.
- **"no free slot at or after …"** (preset) — el horario pedido cae fuera de `hours` o en día
  cerrado; usa otra hora.
- **Se saltó todo (`1 skipped`)** — corriste vitest directo sin `BATTERY_TENANT`; usa
  `pnpm battery <slug>` (así `pnpm eval` nunca la corre por accidente).
