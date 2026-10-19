/**
 * Sequence mode of the follow-up playbook (0070): a stage's touches as an ORDERED
 * story instead of a pool the model picks from.
 *
 * Each step carries a cover mark — the one thing the touch gives the lead — and
 * rung N sends the first step the conversation hasn't covered yet. Marks are per
 * conversation, shared across stages: a lead who saw the price at NI is never
 * sent the price again at I. The model no longer chooses; it only writes the
 * step's text (and the file's caption when the step delivers one).
 *
 * What counts as covered is decided here, deterministically, from what the
 * conversation already holds:
 *   precio       a bot message that states a price (same detector as the stage floor)
 *   quien, que-esperar, prueba, oferta, duda
 *                a sent nudge stamped with that mark (follow_ups.step), or the
 *                step's file already in an outbound message's attachments
 *   cierre       by position: the n-th cierre of the sequence is covered once the
 *                conversation has sent n cierre nudges; when the whole sequence is
 *                told, its last cierre repeats
 *
 * A step with an asset the tenant lacks goes out as text, except `prueba`: a
 * "trust me" without the before/after is noise, so it is skipped.
 */

import { pickAsset, type MediaAsset } from './media-assets.js';
import { mentionsPrice } from './price-mention.js';
import type { Channel } from './types.js';

export const COVER_MARKS = ['precio', 'quien', 'que-esperar', 'prueba', 'oferta', 'duda', 'cierre'] as const;
export type CoverMark = (typeof COVER_MARKS)[number];

/** One step of a stage's sequence. */
export interface StepSpec {
  covers: CoverMark;
  /** The directive the model writes from. */
  text: string;
  /** media_assets.slot this step delivers; absent = text step. */
  asset?: string;
}

export function isCoverMark(s: string): s is CoverMark {
  return (COVER_MARKS as readonly string[]).includes(s);
}

export function parseStep(raw: unknown): StepSpec | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const { covers, text, asset } = raw as { covers?: unknown; text?: unknown; asset?: unknown };
  if (typeof covers !== 'string' || !isCoverMark(covers.trim().toLowerCase())) return null;
  if (typeof text !== 'string' || !text.trim()) return null;
  const step: StepSpec = { covers: covers.trim().toLowerCase() as CoverMark, text: text.trim() };
  if (typeof asset === 'string' && asset.trim()) step.asset = asset.trim();
  return step;
}

/** The marks this conversation has already covered, from its bot messages and its sent steps. */
export function coveredMarks(botMessages: readonly string[], sentSteps: readonly string[]): Set<CoverMark> {
  const covered = new Set<CoverMark>();
  if (botMessages.some(mentionsPrice)) covered.add('precio');
  for (const s of sentSteps) {
    if (isCoverMark(s) && s !== 'cierre') covered.add(s);
  }
  return covered;
}

export interface StepPickInputs {
  covered: ReadonlySet<CoverMark>;
  /** Cierre nudges this conversation has already sent; absent = 0. */
  cierresSent?: number;
  /** URLs already sent as attachments on this conversation (any sender). */
  sentUrls: ReadonlySet<string>;
  assets: readonly MediaAsset[];
  interest: string | null | undefined;
  channel: Channel;
}

export interface StepPick {
  step: StepSpec;
  /** Position in the sequence, for the event. */
  index: number;
  /** The file the step delivers; null = text step (no asset, or the tenant lacks it). */
  file: MediaAsset | null;
}

/** The first step of the sequence the conversation hasn't covered; told → its last cierre again, or null without one. */
export function nextStep(sequence: readonly StepSpec[], input: StepPickInputs): StepPick | null {
  const fileFor = (step: StepSpec) =>
    step.asset ? pickAsset(input.assets, step.asset, input.interest, input.channel) : null;
  let cierresSeen = 0;
  let lastCierre = -1;
  for (const [index, step] of sequence.entries()) {
    if (step.covers === 'cierre') {
      cierresSeen += 1;
      lastCierre = index;
      if (cierresSeen <= (input.cierresSent ?? 0)) continue;
    } else if (input.covered.has(step.covers)) continue;
    const file = fileFor(step);
    if (file && input.sentUrls.has(file.url)) continue;
    if (step.covers === 'prueba' && !file) continue;
    return { step, index, file };
  }
  if (lastCierre < 0) return null;
  const step = sequence[lastCierre]!;
  return { step, index: lastCierre, file: fileFor(step) };
}
