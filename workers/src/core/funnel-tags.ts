/**
 * Funnel tags from appointment status (0074) — the pure half.
 *
 * The client's GHL workflows used to write `agendo:`, `valorado`, `noshow:`, `paciente:`
 * with one branch per calendar. This module is that table, generic per tenant: a
 * calendar map in `tenant_config.funnel_tags` says what each calendar IS (the
 * assessment, or a treatment with a slug), and `funnelPlan` turns (calendar, status,
 * date, the contact's current tags) into the tags to add, the tags to remove and the
 * date fields to write. No IO here — the handler verifies the status live with GHL and
 * does the writes; this file is what the unit tests pin.
 *
 * Nothing in this plan ever ADDS `interes:`, `zona:`, `objecion:`, `cotizo:` or
 * `fuente:` — the removals below are the only time it touches them.
 */

import {
  EVALUATED_TAG,
  INTEREST_TAG_PREFIX,
  NOSHOW_TAG_PREFIX,
  OBJECTION_TAG_PREFIX,
  PATIENT_TAG_PREFIX,
  QUOTED_TAG_PREFIX,
} from '../ghl/tags.js';

export const SCHEDULED_TAG_PREFIX = 'agendo:';

export type CalendarKind = 'assessment' | 'treatment';

export interface FunnelCalendar {
  slug: string;
  kind: CalendarKind;
}

export interface FunnelTagsConfig {
  enabled: boolean;
  /** GHL calendar id → what it books. A calendar outside the map is ignored (logged). */
  calendars: Record<string, FunnelCalendar>;
  /** GHL custom-field IDs (never names: resolving a name needs a scope we don't have). */
  fields: {
    lastVisit?: string;
    /** slug → field id for "último <tratamiento>"; a slug without one writes nothing. */
    lastTreatment: Record<string, string>;
  };
}

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Parse the jsonb; null when absent, disabled or malformed (every bad entry is dropped). */
export function parseFunnelTags(raw: unknown): FunnelTagsConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as { enabled?: unknown; calendars?: unknown; fields?: unknown };
  if (r.enabled !== true) return null;
  const calendars: Record<string, FunnelCalendar> = {};
  if (r.calendars && typeof r.calendars === 'object') {
    for (const [id, v] of Object.entries(r.calendars as Record<string, unknown>)) {
      const c = (v ?? {}) as { slug?: unknown; kind?: unknown };
      if (typeof c.slug !== 'string' || !SLUG.test(c.slug)) continue;
      if (c.kind !== 'assessment' && c.kind !== 'treatment') continue;
      calendars[id] = { slug: c.slug, kind: c.kind };
    }
  }
  if (Object.keys(calendars).length === 0) return null;
  const f = (r.fields ?? {}) as { last_visit?: unknown; last_treatment?: unknown };
  const lastTreatment: Record<string, string> = {};
  if (f.last_treatment && typeof f.last_treatment === 'object') {
    for (const [slug, id] of Object.entries(f.last_treatment as Record<string, unknown>)) {
      if (typeof id === 'string' && id.trim()) lastTreatment[slug] = id.trim();
    }
  }
  return {
    enabled: true,
    calendars,
    fields: {
      lastVisit: typeof f.last_visit === 'string' && f.last_visit.trim() ? f.last_visit.trim() : undefined,
      lastTreatment,
    },
  };
}

/** The statuses the plan knows. `booked`/`confirmed`/`new` are ONE step: the appointment exists. */
export type FunnelStatus = 'scheduled' | 'showed' | 'noshow';

export function normalizeFunnelStatus(raw: string | undefined): FunnelStatus | null {
  switch ((raw ?? '').toLowerCase()) {
    case 'booked':
    case 'confirmed':
    case 'new':
      return 'scheduled';
    case 'showed':
      return 'showed';
    case 'noshow':
    case 'no-show':
    case 'no_show':
      return 'noshow';
    default:
      return null; // cancelled, invalid, unknown: the funnel does nothing
  }
}

export interface FunnelPlan {
  add: string[];
  remove: string[];
  fields: Array<{ id: string; value: string }>;
}

/** Every tag this config may ever write — the allow-list the handler checks before a write. */
export function allowedFunnelTags(config: FunnelTagsConfig): Set<string> {
  const out = new Set<string>([EVALUATED_TAG]);
  for (const c of Object.values(config.calendars)) {
    out.add(`${SCHEDULED_TAG_PREFIX}${c.slug}`);
    out.add(`${NOSHOW_TAG_PREFIX}${c.slug}`);
    if (c.kind === 'treatment') out.add(`${PATIENT_TAG_PREFIX}${c.slug}`);
  }
  return out;
}

/**
 * The table. `currentTags` is what the contact carries now (live), so removals name only
 * tags that are there and additions skip what is already on — both lists are what the
 * handler should actually send. `dateYmd` is the appointment's START date in the tenant's
 * clock (never the webhook's time: reception marks "showed" hours later).
 */
export function funnelPlan(args: {
  config: FunnelTagsConfig;
  calendarId: string;
  status: FunnelStatus;
  dateYmd: string;
  currentTags: readonly string[];
}): FunnelPlan | { ignored: 'unknown_calendar' } {
  const cal = args.config.calendars[args.calendarId];
  if (!cal) return { ignored: 'unknown_calendar' };
  const have = new Set(args.currentTags);
  const add = new Set<string>();
  const remove = new Set<string>();
  const fields: FunnelPlan['fields'] = [];
  const { slug, kind } = cal;

  switch (args.status) {
    case 'scheduled':
      add.add(`${SCHEDULED_TAG_PREFIX}${slug}`);
      if (kind === 'assessment') {
        // Booking the assessment answers the objection, whatever it was.
        for (const t of have) if (t.startsWith(OBJECTION_TAG_PREFIX)) remove.add(t);
      }
      break;
    case 'showed':
      if (kind === 'assessment') {
        add.add(EVALUATED_TAG);
      } else {
        add.add(`${PATIENT_TAG_PREFIX}${slug}`);
        remove.add(`${INTEREST_TAG_PREFIX}${slug}`);
        remove.add(`${QUOTED_TAG_PREFIX}${slug}`);
        const lastTreatment = args.config.fields.lastTreatment[slug];
        if (lastTreatment) fields.push({ id: lastTreatment, value: args.dateYmd });
      }
      remove.add(`${NOSHOW_TAG_PREFIX}${slug}`);
      if (args.config.fields.lastVisit) fields.push({ id: args.config.fields.lastVisit, value: args.dateYmd });
      break;
    case 'noshow':
      add.add(`${NOSHOW_TAG_PREFIX}${slug}`);
      break;
  }

  return {
    add: [...add].filter((t) => !have.has(t)),
    remove: [...remove].filter((t) => have.has(t)),
    fields,
  };
}

/** `YYYY-MM-DD` of an instant in a zone — the value a GHL date field takes. */
export function ymdInZone(iso: string, timeZone: string): string {
  return new Date(iso).toLocaleDateString('sv-SE', { timeZone });
}
