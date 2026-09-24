# Medicina Regenerativa — sitio bilingüe (ES/EN) para Vercel

A diferencia de los otros sitios de `sites/`, este **no se pega en GHL**: es un sitio
estático multipágina que se hostea en Vercel, con una función (`api/contact.mjs`) que
reenvía el formulario a un workflow de GHL. Especificación: el plan maestro del cliente
(copy, rutas, reglas editoriales). No agregues copy que no venga de ahí.

```
_src/build.mjs     # TODO el copy ES/EN + plantillas → genera los index.html (se commitean)
_src/og.html       # fuente de assets/og.png (1200×630) — _src/icon.html → apple-touch-icon
assets/            # site.css, site.js, favicon.svg, og.png, apple-touch-icon.png
api/contact.mjs    # POST /api/contact → GHL_WEBHOOK_URL
img/               # fotos opcionales (ver abajo)
vercel.json        # cleanUrls, sin slash final, headers
```

## Editar

Cambia `_src/build.mjs` y regenera: `node sites/medicina-regenerativa/_src/build.mjs`.
Nunca edites los `index.html` a mano: el siguiente build los sobrescribe.

Interruptores al inicio de `build.mjs`:

| Constante | Hoy | Cuándo cambiarla |
|---|---|---|
| `SITE_URL` | `https://medicinaregenerativatj.com` (vacío → todo `noindex`, sin sitemap) | Solo si cambia el dominio |
| `PUBLISHED` | placenta, proloterapia, quelación, factor de transferencia | Agregar `'nad'` / `'infusion'` cuando el cliente los confirme (el copy ya está) |
| `PRIVACY_APPROVED` | `false` (aviso con noindex) | Cuando el cliente apruebe el aviso |
| `SHOW_TEAM` + `TEAM` | oculto | Con título y cédula confirmados de cada médico (el build falla si faltan) |

Fotos: deja `img/hero.jpg`, `img/presentacion.jpg`, `img/nosotros.jpg` o `img/banner.jpg`
y llena su `alt` ES/EN en `PHOTOS` (el build falla si falta el alt). Sin foto se usa la
composición abstracta.

## Deploy en Vercel

En producción: https://medicinaregenerativatj.com (DNS en Porkbun: `A @` y `A www` → `76.76.21.21`;
`www` redirige 308 al dominio sin www). La carpeta está ligada al proyecto `medicina-regenerativa`
(`.vercel/`, ignorado): para publicar, `node _src/build.mjs` y luego `vercel deploy --prod` desde aquí.

Primera vez / proyecto nuevo:


1. New Project → importar el repo → **Root Directory: `sites/medicina-regenerativa`**,
   Framework Preset: **Other**, sin build command ni output directory.
2. Settings → Environment Variables → `GHL_WEBHOOK_URL` (Production).
3. Tras el deploy: `/`, `/en`, `/tratamientos`, `/en/treatments/prolotherapy` y una ruta
   inexistente (debe dar el 404 propio).

Sin `GHL_WEBHOOK_URL` el formulario **no** finge éxito: la API responde 503 y el visitante ve
"No pudimos enviar tu solicitud… contáctanos por teléfono o WhatsApp".

## GHL: workflow que recibe el formulario

Subcuenta de Medicina Regenerativa (location `nmf4Fx6cBL1WMsAGn8jI`):

1. Custom fields de contacto: `preferred_language` (es/en), `treatment_interest` (código),
   `source_page`, `contact_message`.
2. Workflow "Sitio web — solicitud de contacto" → trigger **Inbound Webhook** → copia su URL a
   `GHL_WEBHOOK_URL`. Manda una solicitud de prueba para que GHL lea el payload.
3. Acción **Create/Update Contact** (deduplica por teléfono/correo) mapeando `first_name`,
   `last_name`, `phone` (E.164), `email`, y los custom fields. Tag sugerido `sitio-web`.
4. Sin SMS/WhatsApp automáticos (plan §14). El correo de confirmación del plan es opcional y
   solo si el lead dejó correo.

Payload que llega (`treatment_interest` es un código estable; la etiqueta legible va aparte):

```json
{ "full_name": "Ana López", "first_name": "Ana", "last_name": "López", "phone": "+526641234567",
  "email": "", "treatment_interest": "chelation", "treatment_interest_label": "Quelación",
  "preferred_language": "es", "contact_message": "", "contact_consent": true,
  "page_language": "es", "source_page": "/contacto", "source": "sitio-web", "submitted_at": "…" }
```
