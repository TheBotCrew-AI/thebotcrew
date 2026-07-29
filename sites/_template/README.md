# _template — scaffold de sitios de cliente

Este es el **chasis**, no un look terminado. Sirve para no re-armar la estructura,
las páginas legales ni el "piso de calidad" en cada cliente. Lo que sí se re-decide
por cliente es la **identidad**. Son dos capas distintas — no las mezcles.

## Las dos capas

**Capa 1 — Chasis (se copia igual entre clientes).**
Esqueleto de secciones, flujo de pegado a GHL, namespace `.site` + reset local,
patrón de CTA de WhatsApp, las dos páginas legales, responsive, focus y
`prefers-reduced-motion`. Esto es trabajo hecho: no lo rediseñes.

**Capa 2 — Identidad (se re-decide para CADA cliente).**
Paleta, par tipográfico y **elemento firma**. Si clonas la identidad de otro cliente,
obtienes justo el "sabor a plantilla" que queremos evitar. Los placeholders de este
scaffold son grises a propósito: si publicas sin cambiarlos, se nota.

> El sitio de Madi (`sites/madi-skincare/`) es **referencia de qué tan lejos llevar
> la identidad**, no un molde para copiar. Su escala de fototipos y su malva son de
> Madi porque su negocio es la piel latina. Otro giro necesita SU propia firma.

## Cómo crear un sitio nuevo

1. Copia la carpeta:
   ```bash
   cp -r sites/_template sites/<slug-del-cliente>
   ```
   Usa el mismo slug que `tenants.slug` en Supabase.

2. **Decide la identidad ANTES de rellenar** (esto es el trabajo real):
   - **Paleta** — derívala del mundo del cliente, no de un genérico. 4–6 colores.
   - **Tipografía** — un par con carácter (display + texto). Evita los defaults
     vistos mil veces (Playfair, Montserrat). Ideas por giro abajo.
   - **Elemento firma** — el `SLOT FIRMA` del hero. ¿Qué tiene ESTE negocio que
     nadie más pondría? Un antes/después, un mapa de zonas, una línea de proceso,
     un número que importe. Sin firma, el sitio se siente genérico.

3. Vuelca la identidad al código:
   - Colores → bloque `MARCA` en `index.html` (variables CSS al inicio del `<style>`).
   - Fuentes → el `@import` **y** las variables `--display` / `--texto` (deben coincidir).
     Repite lo mismo en `privacidad.html` y `terminos.html`.
   - `--radio`: 0–4px se lee serio/clínico; 16–24px suave/cálido.

4. Rellena el contenido: reemplaza todos los `{{MARCADORES}}` (ver tabla abajo) y
   resuelve cada `⚠️ COMPLETAR` / `SLOT`. Borra las secciones que el cliente no use
   (p. ej. la banda de promo, o algún grupo de servicios).

5. Revisa: abre los tres HTML con doble clic. Busca `{{` en los tres archivos —
   no debe quedar ninguno. Verifica que no quede el placeholder del `SLOT FIRMA`.

6. Pásalo a GHL (ver abajo).

## Marcadores `{{...}}`

Negocio: `{{NOMBRE}}` `{{BAJADA}}` (bajo el logo) `{{CIUDAD}}` `{{UBICACION_CORTA}}`
`{{DIRECCION}}` `{{TELEFONO}}` (visible) `{{WA}}` (E.164 sin `+`, ej. `526640000000`)
`{{IG}}` (usuario sin @) `{{HORARIO}}` `{{CORREO}}` `{{FECHA}}`.

Identidad: `{{FUENTE_DISPLAY}}` `{{FUENTE_TEXTO}}` (nombres tal como los pide Google
Fonts en la URL, ej. `Prata`, `Mulish`).

SEO: `{{DESCRIPCION_CORTA}}` `{{META_DESCRIPCION}}`.

Contenido: `{{TITULAR}}` `{{TITULAR_ACENTO}}` `{{SUBTITULAR}}` `{{CTA_PRIMARIO}}`
`{{CTA_SECUNDARIO}}`, los `{{DIF_n_*}}`, `{{SERVICIOS_*}}`, `{{GRUPO_*}}`, `{{SERV_*}}`,
`{{PACK_*}}`, `{{MINI_*}}`, `{{BANDA_*}}`, `{{NOSOTROS_*}}`, `{{VAL_*}}`, `{{FAQ_*}}`,
`{{CONTACTO_*}}`, `{{CTA_CAJA_*}}`, `{{TERMINOS_SERVICIOS}}`.

## Ideas de firma y tipografía por giro (punto de partida, no receta)

| Giro | Firma posible | Par tipográfico posible |
| --- | --- | --- |
| Estética / skin | escala de piel, antes/después | Prata + Mulish |
| Dental | mapa dental, timeline del tratamiento | Fraunces + Inter |
| Gym / fitness | línea de progreso, números grandes | Archivo + Sohne-like |
| Legal / notaría | timeline del caso, índice numerado | Newsreader + Public Sans |
| Restaurante | menú del día, mapa de ingredientes | DM Serif Display + DM Sans |
| Inmobiliaria | ficha de propiedad, mapa de zona | Cormorant + Figtree |

No las tomes literal — son para arrancar la cabeza, no para copiar.

## Cómo pasarlo a GHL

1. En GHL: **Sites → New**, crea la página y borra su contenido.
2. Arrastra un elemento **Custom Code / HTML**.
3. Copia lo que está entre `COPIAR DESDE AQUÍ ↓` y `COPIAR HASTA AQUÍ ↑`
   (el `<style>` y el `<div class="site">`, sin `<html>`/`<head>`/`<body>`).
4. Pega, guarda, publica. Repite para `/privacidad` y `/terminos`; confirma que
   esas rutas coincidan con los `href` del pie de `index.html`.

### Si algo se ve raro en GHL

- **El header no se queda fijo:** algún contenedor de GHL tiene `overflow: hidden`,
  que rompe `position: sticky`. Quita `position: sticky; top: 0;` de `.site-head`.
- **Márgenes/fuentes raras:** GHL inyecta su CSS. Todo va bajo `.site` con reset local;
  si algo se cuela, sube especificidad (`.site .site-card { … }`).
- **Padding lateral doble:** el elemento de GHL ya trae padding. Ponlo en 0 desde el
  builder; el ancho lo controla `.site-wrap`.

## Piso de calidad (ya incluido — no lo rompas)

Responsive a móvil, focus visible en teclado, `prefers-reduced-motion` respetado,
contraste legible, cero JS y cero dependencias externas más allá de Google Fonts.

## Recordatorio Meta (para verificación de cuenta)

El bloqueante suele no ser el sitio sino el **dominio**: Meta espera un dominio propio
del negocio, no una URL genérica de GHL. Y el **nombre + dirección + teléfono** del sitio
deben coincidir exactos con Business Manager. La dirección completa (calle, número, local,
C.P.) es obligatoria — no la dejes en "Plaza X, Zona Y".

Los textos legales son un punto de partida redactado para negocios de servicio en México,
no asesoría jurídica. Que el cliente los revise.
