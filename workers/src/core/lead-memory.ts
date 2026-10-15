/**
 * Lead memory from GHL tags (0073) — read-only.
 *
 * The client's own GHL workflows write the funnel tags (`paciente:botox`,
 * `cotizo:acido-hialuronico`, `valorado`, `noshow:…`) and the classifier writes
 * `zona:<slug>`. Together they are what the business already knows about this
 * contact, and the front-desk agent should not sell botox to a botox patient or ask
 * what they would like to improve when the tags already say "labios, ojeras".
 *
 * This module turns the contact's tag list into ONE line for the prompt. Nothing here
 * writes a tag, and the funnel prefixes are never written anywhere in the Worker.
 */

import {
  EVALUATED_TAG,
  NOSHOW_TAG_PREFIX,
  PATIENT_TAG_PREFIX,
  QUOTED_TAG_PREFIX,
  ZONE_TAG_PREFIX,
} from '../ghl/tags.js';
import { serviceSlug, type InterestService } from './interest.js';

export interface CatalogEntry {
  slug: string;
  label: string;
  hints: string[];
}

/** Parse a `zone_catalog` / `objection_catalog` jsonb; malformed entries are dropped. */
export function parseCatalog(raw: unknown): CatalogEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: CatalogEntry[] = [];
  for (const e of raw) {
    if (!e || typeof e !== 'object') continue;
    const { slug, label, hints } = e as { slug?: unknown; label?: unknown; hints?: unknown };
    if (typeof slug !== 'string' || !slug.trim()) continue;
    out.push({
      slug: slug.trim(),
      label: typeof label === 'string' && label.trim() ? label.trim() : slug.trim(),
      hints: Array.isArray(hints) ? hints.filter((h): h is string => typeof h === 'string' && !!h.trim()) : [],
    });
  }
  return out;
}

export interface LeadMemory {
  /** Configured service names the contact is already a patient of. */
  patientOf: string[];
  /** Configured service names the contact was quoted. */
  quoted: string[];
  /** Zone labels (from the catalog, else the raw slug) the contact has been tagged with. */
  zones: string[];
  evaluated: boolean;
  noShows: string[];
}

/** Does the contact already carry `paciente:<slug>` for this configured service? */
export function isPatientOf(tags: readonly string[], service: InterestService): boolean {
  return tags.includes(`${PATIENT_TAG_PREFIX}${serviceSlug(service)}`);
}

function valuesWithPrefix(tags: readonly string[], prefix: string): string[] {
  return tags.filter((t) => t.startsWith(prefix)).map((t) => t.slice(prefix.length)).filter(Boolean);
}

/** Map tag slugs back to the configured service names; an unknown slug is kept as-is so the
 *  agent still learns "paciente de <algo>" for a service the config does not list. */
function serviceLabels(slugs: string[], services: InterestService[]): string[] {
  return slugs.map((slug) => services.find((s) => serviceSlug(s) === slug)?.name ?? slug);
}

export function readLeadMemory(
  tags: readonly string[] | undefined,
  services: InterestService[],
  zoneCatalog: CatalogEntry[],
): LeadMemory {
  const t = tags ?? [];
  return {
    patientOf: serviceLabels(valuesWithPrefix(t, PATIENT_TAG_PREFIX), services),
    quoted: serviceLabels(valuesWithPrefix(t, QUOTED_TAG_PREFIX), services),
    zones: valuesWithPrefix(t, ZONE_TAG_PREFIX).map((slug) => zoneCatalog.find((z) => z.slug === slug)?.label ?? slug),
    evaluated: t.includes(EVALUATED_TAG),
    noShows: valuesWithPrefix(t, NOSHOW_TAG_PREFIX),
  };
}

function joinEs(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} y ${items[items.length - 1]}`;
}

/**
 * The prompt line: "Este contacto: paciente de Botox; se le cotizó Ácido Hialurónico; le
 * preocupan labios y ojeras." Empty string when the tags say nothing.
 */
export function leadMemoryLine(memory: LeadMemory): string {
  const parts: string[] = [];
  if (memory.patientOf.length) parts.push(`ya es paciente de ${joinEs(memory.patientOf)}`);
  if (memory.evaluated) parts.push('ya tuvo su valoración');
  if (memory.quoted.length) parts.push(`se le cotizó ${joinEs(memory.quoted)}`);
  if (memory.zones.length) parts.push(`le preocupa${memory.zones.length > 1 ? 'n' : ''} ${joinEs(memory.zones)}`);
  if (memory.noShows.length) parts.push(`no llegó a una cita (${joinEs(memory.noShows)})`);
  return parts.length ? `Este contacto: ${parts.join('; ')}.` : '';
}
