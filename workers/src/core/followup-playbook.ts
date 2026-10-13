/**
 * The follow-up playbook (0068): which ladder and which angles a silent lead gets,
 * chosen by how far they got (their stage, 0067) and what they asked about (their
 * interest, 0058).
 *
 *   tenant_config.follow_up_playbook = {
 *     "stages": {
 *       "NI": { "cadence": [10, 60, 240, 1200], "objective": "…", "angles": ["…"] },
 *       "I":  { … }, "A": { … }, "C": { … }
 *     },
 *     "byInterest": {
 *       "Botox": { "NI": { "angles": ["…"] }, "C": { … } }
 *     }
 *   }
 *
 * An angle is a directive string, or (0069) `{ "asset": "<slot>", "text": "<directive>" }`
 * — a touch that DELIVERS a file from media_assets with the message. The runner
 * drops an asset angle whose file the tenant lacks (or the channel can't carry),
 * so the pool degrades to its text angles rather than to a file-less promise.
 *
 * Every key is optional. NULL playbook = the flat ladder exactly as before 0068.
 * Resolution, most specific first:
 *   cadence   byInterest[interest][stage] → stages[stage] → tenant follow_up_cadence
 *   objective byInterest[interest][stage] → stages[stage] → the platform default
 *   angles    byInterest[interest][stage] → stages[stage] → variant pool → tenant pool
 * Only round 0 takes the playbook cadence; rounds 1+ keep the 0049 taper.
 *
 * Angle indexes are positions within ONE pool, so each resolved pool carries a
 * `poolKey` and the sent-angle cursor is read per pool (follow_ups.angle_pool).
 * Malformed config degrades to the flat ladder, never to silence.
 */

import { resolveAnglePool } from '../roles/reactivation/angle-select.js';
import { LEAD_STAGES, type LeadStage } from './lead-stage.js';

/** One angle of a pool: what to say, and optionally which file to send with it. */
export interface AngleSpec {
  text: string;
  /** media_assets.slot this angle delivers; absent = text-only angle. */
  asset?: string;
}

export interface StagePlan {
  cadence?: number[];
  objective?: string;
  angles?: AngleSpec[];
}

export interface FollowUpPlaybook {
  stages: Partial<Record<LeadStage, StagePlan>>;
  byInterest: Record<string, Partial<Record<LeadStage, StagePlan>>>;
}

/** What the lead at each stage still needs — the nudge's job when the tenant wrote none. */
export const DEFAULT_STAGE_OBJECTIVES: Record<LeadStage, string> = {
  NI: 'Este lead sólo mandó el mensaje del anuncio y no ha conversado. Dale en UNA línea el dato que el anuncio prometía (qué incluye, precio o cómo funciona), tomado de "Lo que le interesa", y cierra con una pregunta cerrada facilísima sobre su caso. Todavía NO le pidas agendar.',
  I: 'Este lead ya vio la oferta o el precio y se detuvo ahí. Quítale en UNA línea la duda más común del tratamiento (si duele, cuánto dura, quién lo aplica, si es seguro), con datos de "Lo que le interesa", y pregunta si quiere saber si es candidata o candidato.',
  A: 'Este lead ya preguntó por su caso. Retoma SU situación con sus propias palabras, dile en una línea qué pasa en la consulta o valoración, y pregunta si quiere que le aparten un lugar.',
  C: 'Este lead ya pidió horarios o dijo que sí quiere. Tu único trabajo es cerrar: alude a los horarios que ya vio sin repetirlos y pregunta si le aparta uno o le busca otro. Nada de información nueva.',
};

export const STAGE_LABELS: Record<LeadStage, string> = {
  NI: 'sin información (sólo el mensaje del anuncio)',
  I: 'con información (vio la oferta y se detuvo)',
  A: 'en asesoría (preguntó por su caso)',
  C: 'en compromiso (pidió horarios o dijo que sí)',
};

function isStage(s: string): s is LeadStage {
  return (LEAD_STAGES as readonly string[]).includes(s);
}

function parseAngle(raw: unknown): AngleSpec | null {
  if (typeof raw === 'string') return raw.trim() ? { text: raw.trim() } : null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const { text, asset } = raw as { text?: unknown; asset?: unknown };
  if (typeof text !== 'string' || !text.trim()) return null;
  const spec: AngleSpec = { text: text.trim() };
  if (typeof asset === 'string' && asset.trim()) spec.asset = asset.trim();
  return spec;
}

function parsePlan(raw: unknown): StagePlan | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const plan: StagePlan = {};
  if (Array.isArray(r.cadence)) {
    const c = r.cadence.filter((n): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0);
    if (c.length) plan.cadence = c;
  }
  if (typeof r.objective === 'string' && r.objective.trim()) plan.objective = r.objective.trim();
  if (Array.isArray(r.angles)) {
    const a = r.angles.map(parseAngle).filter((x): x is AngleSpec => x !== null);
    if (a.length) plan.angles = a;
  }
  return Object.keys(plan).length ? plan : null;
}

function parseStageMap(raw: unknown): Partial<Record<LeadStage, StagePlan>> {
  const out: Partial<Record<LeadStage, StagePlan>> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const key = k.trim().toUpperCase();
    if (!isStage(key)) continue;
    const plan = parsePlan(v);
    if (plan) out[key] = plan;
  }
  return out;
}

/** The jsonb as stored → a typed playbook, or null when absent/unusable. */
export function parseFollowUpPlaybook(raw: unknown): FollowUpPlaybook | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const stages = parseStageMap(r.stages);
  const byInterest: FollowUpPlaybook['byInterest'] = {};
  if (r.byInterest && typeof r.byInterest === 'object' && !Array.isArray(r.byInterest)) {
    for (const [name, v] of Object.entries(r.byInterest as Record<string, unknown>)) {
      const m = parseStageMap(v);
      if (Object.keys(m).length) byInterest[name] = m;
    }
  }
  if (!Object.keys(stages).length && !Object.keys(byInterest).length) return null;
  return { stages, byInterest };
}

export interface ResolvedPlan {
  /** Round-0 cadence (minutes per rung). */
  cadence: number[];
  /** Angle directives for this lead; may be the legacy variant/tenant pool (text-only). */
  angles: AngleSpec[];
  /** Identity of the pool `angles` came from — the sent-angle cursor is per pool. */
  poolKey: string;
  /** Instruction for the nudge; null when the playbook is off (prompt unchanged). */
  objective: string | null;
  /** Where the angles came from, for the event. */
  angleSource: 'interest' | 'stage' | 'variant' | 'tenant';
}

export interface PlanInputs {
  followUpCadence?: number[] | null;
  followUpAngles?: string[] | null;
  promptVariants?: unknown;
}

/** Case- and accent-tolerant match of the persisted interest against byInterest keys. */
function findInterest(playbook: FollowUpPlaybook, interest: string | null | undefined): Partial<Record<LeadStage, StagePlan>> | null {
  if (!interest) return null;
  const norm = (s: string) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
  const want = norm(interest);
  for (const [k, v] of Object.entries(playbook.byInterest)) {
    if (norm(k) === want) return v;
  }
  return null;
}

/**
 * The ladder + pool for one silent lead. With no playbook (or no stage yet) this
 * is exactly the pre-0068 resolution: tenant cadence, variant-then-tenant pool,
 * no objective — the prompt stays byte-identical.
 */
export function resolveStagePlan(
  playbook: FollowUpPlaybook | null,
  stage: LeadStage | null | undefined,
  interest: string | null | undefined,
  config: PlanInputs,
  variantKey: string | null | undefined,
): ResolvedPlan {
  const legacy = resolveAnglePool(config.promptVariants, variantKey, config.followUpAngles ?? []);
  const base: ResolvedPlan = {
    cadence: config.followUpCadence ?? [],
    angles: legacy.pool.map((text) => ({ text })),
    poolKey: legacy.source === 'variant' ? `variant:${variantKey}` : 'tenant',
    objective: null,
    angleSource: legacy.source,
  };
  if (!playbook || !stage) return base;

  const byStage = playbook.stages[stage] ?? null;
  const byInt = findInterest(playbook, interest)?.[stage] ?? null;

  const cadence = byInt?.cadence ?? byStage?.cadence ?? base.cadence;
  const objective = byInt?.objective ?? byStage?.objective ?? DEFAULT_STAGE_OBJECTIVES[stage];

  if (byInt?.angles) {
    return { cadence, objective, angles: byInt.angles, poolKey: `interest:${interest}/${stage}`, angleSource: 'interest' };
  }
  if (byStage?.angles) {
    return { cadence, objective, angles: byStage.angles, poolKey: `stage:${stage}`, angleSource: 'stage' };
  }
  return { ...base, cadence, objective };
}

/** A legacy pool key (rows written before 0068 carry NULL and belong to these). */
export function isLegacyPoolKey(poolKey: string): boolean {
  return poolKey === 'tenant' || poolKey.startsWith('variant:');
}

/** The one service entry the nudge may state facts from, by the persisted interest. */
export function serviceFacts(services: unknown, interest: string | null | undefined): { name: string; description: string | null } | null {
  if (!interest || !Array.isArray(services)) return null;
  const norm = (s: string) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
  for (const s of services) {
    if (!s || typeof s !== 'object') continue;
    const { name, description } = s as { name?: unknown; description?: unknown };
    if (typeof name === 'string' && norm(name) === norm(interest)) {
      return { name, description: typeof description === 'string' && description.trim() ? description.trim() : null };
    }
  }
  return null;
}
