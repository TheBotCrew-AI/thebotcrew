# Dr. Heriberto Valdivia — sitio

Consultorio de medicina estética y regenerativa en Plaza Cumbres, Chihuahua.
WhatsApp +52 614 514 9916 · @dr.heribertovaldivia · contacto@drvaldiviamedstetic.com.

Tres archivos HTML autocontenidos (markup + CSS inline, cero JS, cero dependencias
salvo Google Fonts). El logo va embebido como data URI en los tres; `logo.jpg` es la
copia de referencia y no la carga ninguna página.

| Archivo | Página GHL sugerida |
| --- | --- |
| `index.html` | `/` |
| `privacidad.html` | `/privacidad` |
| `terminos.html` | `/terminos` |

Ábrelos con doble clic para verlos en el navegador antes de publicar.

## Propósito

Desbloquear la verificación del negocio en Meta. No está pensado para captar leads —
eso lo hace el bot por WhatsApp — así que el sitio dice solo lo que sabemos que es
cierto y nada más: sin promos, sin claims de "certificado" u "original", sin promesas
de resultado, sin fotos ni bios que no tenemos.

## Concepto de diseño

**El logo manda.** Es un monograma «ME» en Didone de alto contraste, negro sobre
blanco, con el nombre en sans geométrica con tracking. Eso es editorial, de revista —
no spa pastel — y el sitio lo sigue en vez de pelearse con él.

- **Paleta:** papel cálido `#F7F5F1`, tinta `#111111`, campo `#ECE8E1`. Un solo
  acento, bronce apagado `#9A7B4F`, y aparece poco a propósito (numerales, eyebrows,
  filetes): el negro/blanco del logo sigue siendo el protagonista. Los botones
  principales son tinta, no bronce.
- **Tipografía:** Bodoni Moda (display — hermana del monograma) con Jost (texto — la
  geométrica del logo). `--radio: 2px`: clínico, serio.
- **Elemento firma: el «Índice de indicaciones»** bajo el hero. Lo que la persona
  quiere mejorar → con qué se trabaja, numerado como tabla de contenido en Bodoni y con
  filetes finos. Convierte la lista de precios en una lectura desde el problema, y deja
  dicho en la misma línea que qué conviene lo define el doctor en consulta. Es de este
  consultorio: nadie más tiene exactamente este catálogo.
- **Fondo del hero:** el propio monograma «ME» en marca de agua (3.5 % de tinta), en
  lugar del resplandor genérico del template.
- **Tesis del sitio (y del bot):** *primero la consulta, después el tratamiento*. Toda
  persona nueva pasa por consulta con el doctor; el sitio lo repite en el hero, en la
  tira, en la sección «La consulta» y en el FAQ, porque es lo que evita que alguien
  llegue queriendo "agendar un Sculptra".

## Cómo editar

Todo el sistema visual vive en el bloque `MARCA` arriba del CSS de `index.html`; las
páginas legales repiten los mismos valores en su propio bloque. Si cambias la paleta o
las fuentes, actualiza los tres.

- **Precios** están en el markup dentro de `<span class="site-precio">`; la unidad
  («por jeringa», «por sesión», «por 10 sesiones») va en el `<span>` interior. Búscalos
  con `$`.
- **El logo** es un JPG cuadrado con mucho aire blanco. En el encabezado (y en las
  legales) se recorta con `object-fit: cover; object-position: 50% 57%` en una caja de
  200×84 px (160×68 en móvil) para dejar solo el monograma y el nombre, y
  `mix-blend-mode: multiply` funde su fondo blanco con el papel — sin eso queda un
  rectángulo blanco sobre el crema. Si el recorte corta el «Y REGENERATIVA» o deja aire
  de más, mueve el segundo valor de `object-position` (más % = baja la ventana).
  Verificado en Chrome headless a 1280 y 390 px. En el pie va completo dentro de un
  sello blanco de 76 px, porque es negro sobre blanco y en la banda negra no puede ir suelto.
- **Botones**: las variantes van como `.site .site-btn--acento` (dos clases) a propósito —
  `.site a { color: inherit }` tiene más especificidad que `.site-btn--acento` a secas y
  pintaba el texto del botón negro sobre negro. El `_template` trae ese mismo bug.
- **WhatsApp** aparece en 5 enlaces de `index.html` con mensaje precargado (menú, hero,
  caja de contacto, NAP, pie). Búscalo como `wa.me/526145149916`.
- **Datos NAP** (nombre, dirección, teléfono): la dirección completa está escrita
  idéntica, en una sola línea, en las tres páginas — no la reformatees.

## Cómo pasarlo a GHL

1. En GHL: **Sites → Funnels/Websites → New**, crea la página y borra todo su contenido.
2. Arrastra un elemento **Custom Code / HTML**.
3. En el archivo, copia lo que está entre `COPIAR DESDE AQUÍ ↓` y `COPIAR HASTA AQUÍ ↑`
   (el `<style>` y el `<div class="site">` — sin `<html>`, `<head>` ni `<body>`).
4. Pega, guarda, publica.
5. Repite para `/privacidad` y `/terminos`, y confirma que esas rutas coincidan con los
   enlaces del pie de `index.html`. Si en GHL quedan con otro path, corrige los `href`.
6. Pon el `<title>` y la meta description de cada página en los ajustes SEO de la página
   en GHL (el `<head>` no se pega).

### Si algo se ve raro en GHL

- **El encabezado no se queda fijo al hacer scroll.** Algún contenedor de GHL tiene
  `overflow: hidden`, que rompe `position: sticky`. Quita `position: sticky; top: 0;`
  de `.site-head`.
- **Márgenes o fuentes que no cuadran.** GHL inyecta su propia hoja de estilos. Todo va
  bajo `.site` con reset local; si algo se cuela, sube la especificidad
  (`.site .site-card { … }`).
- **Padding lateral doble.** El elemento de GHL ya trae padding. Ponlo en 0 desde el
  builder; el ancho lo controla `.site-wrap`.
- **El data URI del logo pesa ~13 KB** y va dos veces en `index.html`; GHL lo acepta sin
  problema, pero si el editor lo recorta, sube `logo.jpg` a la Media Library y cambia los
  dos `src` por esa URL.

## Dominio y verificación en Meta

- El dominio es **drvaldiviamedstetic.com**. Hay que apuntarlo al funnel de GHL
  (Sites → Domains → Add domain, y el CNAME que GHL indique en el DNS del registrador).
  Meta rechaza URLs genéricas de GHL: el sitio tiene que abrir en el dominio propio.
- El correo del sitio es `contacto@drvaldiviamedstetic.com`; conviene que exista de
  verdad (Meta a veces manda ahí el código de verificación).
- **Nombre, dirección y teléfono** deben coincidir letra por letra con Business Manager y
  con el documento que se suba: `Dr. Heriberto Valdivia` · `Periférico de la Juventud
  6902, Plaza Cumbres, Chihuahua, Chihuahua, C.P. 31217` · `+52 614 514 9916`. Si en el
  documento aparece una razón social distinta, cámbiala en las tres páginas antes de
  enviar la verificación.

## Lo que se dejó fuera a propósito (no lo tenemos confirmado)

- Si la consulta estética tiene costo, y si el tratamiento se aplica el mismo día.
- Duración de cada procedimiento, duración del efecto, sesiones necesarias, cuidados.
- Meses sin intereses, promociones, política formal de cancelación (hoy: «avísanos por
  WhatsApp»).
- Fotos del consultorio y del doctor, cédula profesional, bio. El sitio funciona sin
  ellas; para verificación no hacen falta.

Los textos legales son un punto de partida redactado para un consultorio médico en
México, no asesoría jurídica. Que el cliente los revise.
