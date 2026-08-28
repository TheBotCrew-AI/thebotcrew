# sites/ — Sitios web de clientes

Sitios de una sola página, HTML autocontenido (markup + CSS inline, cero JS, cero
dependencias salvo Google Fonts). Se pegan tal cual en un bloque de Custom Code de GHL —
no se hostean aparte. Pensados sobre todo para clientes sin sitio que necesitan uno
para verificar su cuenta en Meta.

```
sites/
  _template/           # scaffold neutro — punto de partida de cada cliente
  madi-skincare/       # primer cliente (referencia de identidad, no molde)
  <client-slug>/       # una carpeta por cliente (kebab-case del nombre; no hay columna slug en la DB)
```

## Modelo de dos capas

Un sitio nuevo NO es "clonar el anterior y cambiar colores" — eso produce sabor a
plantilla. Se separa en:

- **Chasis** (se repite): estructura de secciones, flujo de pegado a GHL, páginas
  legales, responsive y accesibilidad. Vive en `_template/`.
- **Identidad** (se re-decide por cliente): paleta, tipografía y elemento firma. Es el
  trabajo real de cada sitio y no se automatiza.

Para crear uno: `cp -r sites/_template sites/<slug>` y sigue
[`_template/README.md`](_template/README.md). Madi es referencia de qué tan lejos llevar
la identidad, no algo para copiar.

## Convenciones

- Contenido en **español**, salvo que el cliente pida otra cosa.
- Slug de la carpeta: kebab-case del nombre del cliente (`madi-skincare`, `dr-valdivia`). No existe una
  columna `slug` en `tenants`; el único slug en la DB es `tenant_config.ai_key_ref`, y es otra cosa.
- Autocontenido: cada sitio se pega en GHL; no entra al workspace de pnpm.
- Sin secretos en el repo.

## Meta

El bloqueante de verificación suele ser el **dominio** (Meta espera uno propio del
negocio, no una URL genérica de GHL) y que **nombre + dirección + teléfono** coincidan
exactos con Business Manager. Detalle en `_template/README.md`.
