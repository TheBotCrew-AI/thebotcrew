/**
 * Interest tags (0058): which configured service a lead is asking about, so the GHL
 * contact can carry `interes-<servicio>` for smart lists and campaigns.
 *
 * The pick is made by the status classifier (one aux model call per replied turn when
 * the tenant opts in); this module holds the parts that don't need a model — the
 * service list handed to the prompt, the prompt addendum, and the validation that only
 * lets a CONFIGURED name through. The model chooses from a closed list; anything else
 * is dropped, so a hallucinated treatment can never become a tag.
 */

import { serviceSchema } from '../roles/front-desk/config.js';

/** The configured service names, in config order. Tolerates a malformed `services`. */
export function serviceNames(rawServices: unknown): string[] {
  if (!Array.isArray(rawServices)) return [];
  const names: string[] = [];
  for (const s of rawServices) {
    const parsed = serviceSchema.safeParse(s);
    if (parsed.success && parsed.data.name.trim()) names.push(parsed.data.name.trim());
  }
  return names;
}

/** Case- and accent-insensitive key: "Ácido Hialurónico" and "acido hialuronico" collide. */
function fold(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

/**
 * The service name the classifier returned, resolved to the CONFIGURED spelling — or
 * null when it is absent, not a string, or not one of the tenant's services.
 */
export function matchInterest(services: string[], raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const key = fold(raw);
  return services.find((name) => fold(name) === key) ?? null;
}

/**
 * Appended to the classifier prompt ONLY for tenants with interest tags on, so every
 * other tenant's prompt stays byte-identical. The model must copy a name verbatim from
 * the list; `matchInterest` forgives case and accents but nothing else.
 */
export function interestPromptAddendum(services: string[]): string {
  return `

Además, indica en qué servicio muestra interés el lead EN ESTE mensaje, eligiendo UNO de esta lista, copiado tal cual:
${services.map((s) => `- ${s}`).join('\n')}
Si el lead no muestra interés claro en uno de esos servicios (saluda, pregunta por ubicación u horarios, habla de su cita, o menciona algo que no está en la lista), devuelve null. No inventes servicios.

Responde SOLO con JSON: {"status":"<estado>","interest":"<servicio de la lista>"} o {"status":"<estado>","interest":null}. Sin explicaciones.`;
}
