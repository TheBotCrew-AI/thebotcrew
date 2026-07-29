# MADI Skin Care — sitio

Centro de cuidado de la piel en Plaza Financiera, Zona Río, Tijuana, B.C.
WhatsApp 664 245 9214.

Tres archivos HTML autocontenidos (markup + CSS inline, cero JS, cero dependencias).
Se pegan tal cual en bloques de Custom Code de GHL.

| Archivo | Página GHL sugerida |
| --- | --- |
| `index.html` | `/` |
| `privacidad.html` | `/privacidad` |
| `terminos.html` | `/terminos` |

Ábrelos con doble clic para verlos en el navegador antes de publicar.

## Cómo pasarlo a GHL

1. En GHL: **Sites → Funnels/Websites → New**, crea la página y borra todo su contenido.
2. Arrastra un elemento **Custom Code / HTML**.
3. En el archivo, copia lo que está entre `COPIAR DESDE AQUÍ ↓` y `COPIAR HASTA AQUÍ ↑`
   (o sea, el `<style>` y el `<div class="madi">` — sin `<html>`, `<head>` ni `<body>`).
4. Pega, guarda, publica.
5. Repite para `/privacidad` y `/terminos`, y confirma que esas rutas coincidan con los
   enlaces del pie de `index.html`. Si en GHL quedan con otro path, corrige los `href`.

### Si algo se ve raro en GHL

- **El encabezado no se queda fijo al hacer scroll.** Algún contenedor de GHL tiene
  `overflow: hidden`, que rompe `position: sticky`. Quita `position: sticky; top: 0;`
  de `.madi-head` y listo.
- **Márgenes o fuentes que no cuadran.** GHL inyecta su propia hoja de estilos. Todo aquí
  está bajo `.madi` con reset local, pero si algo se cuela, sube la especificidad
  (`.madi .madi-card { ... }`).
- **Padding lateral doble.** El elemento de GHL ya trae padding. Ponlo en 0 desde el
  builder; el ancho lo controla `.madi-wrap`.

## Cómo editar

Todo el sistema visual vive en el bloque `MARCA` arriba del CSS de `index.html`.
Cambiando esas ~12 variables cambia la identidad completa:

| Variable | Qué es |
| --- | --- |
| `--nacar` / `--rosa` / `--blanco` | fondos y tarjetas |
| `--malva` / `--malva-osc` / `--rubor` | el acento |
| `--vino` / `--vino-2` | bandas profundas (apertura y pie) |
| `--tinta` / `--humo` / `--bruma` | jerarquía de texto |
| `--display` / `--texto` | tipografías (Prata + Mulish) |

Las páginas legales repiten los mismos valores en su propio bloque; si cambias la
paleta, actualízalas también.

Los precios están escritos en el markup, dentro de `<span class="madi-precio">`.
Búscalos con `$` y edítalos ahí.

El WhatsApp aparece en 4 enlaces con mensaje precargado distinto según la sección
(diagnóstico, promo, contacto). Búscalo como `wa.me/526642459214`.

## Concepto de diseño

**Nude luminoso.** Base clara y aireada —blanco rosado y rosa palo— con un resplandor
suave detrás del héroe, porque lo que MADI vende es luz sobre la piel: fototerapia LED,
láser de diodo, "Glow". El acento es malva, no rosa chicle: femenino sin volverse
juvenil. Bordes redondeados y sombras suaves en todo; la suavidad es el tema.

Dos bandas en vino profundo (apertura y pie) dan contraste y ritmo sin recurrir a
oscuros fríos o masculinos.

**Elemento firma: la escala de fototipos I–VI** bajo el héroe. Convierte "especialistas en
pieles latinas" —un claim que cualquiera puede escribir— en un argumento técnico
verificable: el láser de diodo sí es la tecnología indicada para fototipos altos, donde
IPL y alexandrita no lo son. Se repite como filete en el pie.

**Tipografía:** Prata (serif de alto contraste, elegante y claramente femenina, mucho
menos vista que Playfair o Cormorant) con Mulish, de terminaciones redondeadas y cálidas.

> Versión anterior (café espresso + ámbar + Bodoni) descartada: se leía masculina —
> paleta de whisky y barbería— y no le hablaba al público real, que son mujeres.

## Pendientes antes de publicar

Búscalos en el código como `⚠️ COMPLETAR`.

- [ ] **Dirección completa** — calle, número, local y C.P. Meta la exige para verificar
      y tiene que coincidir letra por letra con Business Manager. Es el bloqueante #1.
- [ ] **Horarios de atención** — hoy dice "consulta por WhatsApp".
- [ ] **Correo de contacto** — el aviso de privacidad tiene `hola@madiskincare.com` de
      relleno; se necesita uno real para solicitudes ARCO.
- [ ] **Qué incluye el Facial Signature MADI** — la info que tenemos solo dice "premium
      personalizado".
- [ ] **Masajes** — tipos, duración y precio.
- [ ] **Política de cancelación real** — los términos traen 24 h / 15 min de tolerancia
      como marcador de posición.
- [ ] **Vigencia de la promo de apertura** — fecha exacta.
- [ ] **Verificar el usuario de Instagram** (`@madiskincare_mx`, sin confirmar).
- [ ] **Revisar el claim del láser de diodo con la clienta** antes de publicar.
- [ ] **Fotos.** El sitio está diseñado para funcionar sin ellas, pero cabina, equipo y
      antes/después subirían mucho la conversión.

Los textos legales son un punto de partida redactado para el giro, no asesoría jurídica.
Que la clienta los revise.

## Verificación en Meta

Lo que más se rechaza no es el sitio, es el dominio: Meta espera un dominio propio del
negocio (idealmente con correo `@sudominio.com`), no una URL genérica de GHL. La clienta
necesita comprar su dominio y apuntarlo al funnel. Nombre legal, dirección y teléfono del
sitio deben coincidir exactos con Business Manager y con el documento que suban.
