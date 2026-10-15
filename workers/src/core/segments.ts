/**
 * Segment tags (0073): zones and objections, chosen by the status classifier from the
 * tenant's catalogs and written as `zona:<slug>` / `objecion:<slug>`.
 *
 * Same contract as interest (core/interest.ts): the model picks from a CLOSED list that
 * the prompt builds from `zone_catalog` / `objection_catalog` (slug + hints), and the
 * validation here lets only a catalog slug through — with ONE escape hatch, `otro`,
 * for a concern or a reason the lead stated that the catalog lacks. `otro` is what a
 * person reviews weekly (the Worker leaves the lead's words as a contact note) and
 * then promotes into the catalog by hand; the system never grows it.
 */

import type { CatalogEntry } from './lead-memory.js';

export const OTHER_SLUG = 'otro';
export const MAX_ZONES = 3;

function fold(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

/**
 * One model-returned value → a catalog slug, `otro` when it is a real value the catalog
 * lacks (so a person can review it), null when it is empty / not a string / already `otro`
 * with nothing behind it. Matches the slug or the label, case- and accent-insensitive.
 */
export function matchCatalog(catalog: CatalogEntry[], raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const key = fold(raw);
  if (key === OTHER_SLUG) return OTHER_SLUG;
  const hit = catalog.find((e) => fold(e.slug) === key || fold(e.label) === key);
  return hit ? hit.slug : OTHER_SLUG;
}

/** The zones array: 0–3 validated slugs, deduped, in the model's order. Non-arrays → []. */
export function matchZones(catalog: CatalogEntry[], raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const v of raw) {
    const slug = matchCatalog(catalog, v);
    if (slug && !out.includes(slug)) out.push(slug);
    if (out.length >= MAX_ZONES) break;
  }
  return out;
}

function catalogLines(catalog: CatalogEntry[]): string {
  return catalog
    .map((e) => `- ${e.slug}${e.hints.length ? ` (${e.hints.join(', ')})` : ''}`)
    .join('\n');
}

/**
 * The classifier addendum for a tenant with `segment_tags` on. Replaces
 * `interestPromptAddendum` (it carries the interest question too, so the JSON contract is
 * stated once). Built from the catalogs, never hardcoded: a slug added by the operator
 * is in the next turn's prompt.
 */
export function segmentPromptAddendum(
  services: string[],
  zones: CatalogEntry[],
  objections: CatalogEntry[],
): string {
  return `

Además, indica en qué servicio muestra interés el lead EN ESTE mensaje, eligiendo UNO de esta lista, copiado tal cual:
${services.map((s) => `- ${s}`).join('\n')}
Si el lead no muestra interés claro en uno de esos servicios (saluda, pregunta por ubicación u horarios, habla de su cita, o menciona algo que no está en la lista), devuelve null. No inventes servicios.

"zones": las ZONAS o preocupaciones que el lead DIJO en este mensaje (de 0 a ${MAX_ZONES}), usando el slug de esta lista; entre paréntesis van sinónimos que la gente usa:
${catalogLines(zones)}
Sólo lo que la persona dijo, no lo que infieras: "me molesta la frente" → ["frente"]; "quiero verme mejor" → []. Si nombra una zona o preocupación concreta que NO está en la lista, pon "${OTHER_SLUG}".

"objection": la razón que el lead dio EN ESTE mensaje para NO agendar (máximo UNA), con el slug de esta lista:
${catalogLines(objections)}
Si no dio ninguna razón para no agendar, null. Si dio una que no está en la lista, "${OTHER_SLUG}".

Responde SOLO con JSON: {"status":"<estado>","interest":"<servicio de la lista>" o null,"zones":[...],"objection":"<slug>" o null}. Sin explicaciones.`;
}
