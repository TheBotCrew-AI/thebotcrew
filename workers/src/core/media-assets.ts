/**
 * Media assets (0069): the file a playbook angle delivers with its message.
 *
 * A playbook angle may be `{ "asset": "<slot>", "text": "<directive>" }`. The
 * runner resolves the slot against the tenant's `media_assets` rows and the
 * lead's channel; an angle whose file is missing (or can't be delivered on that
 * channel) is simply not offered, so the nudge falls back to the pool's text
 * angles — a tenant with no files yet runs the same playbook as text.
 *
 * What each channel delivers (measured 2026-10-12): WhatsApp image + document,
 * Facebook image + document, Instagram image only. Audio/video are not in the
 * `kind` catalogue yet — the voice-note phase adds them.
 */

import type { Channel } from './types.js';

export type MediaKind = 'image' | 'document';

export interface MediaAsset {
  slot: string;
  kind: MediaKind;
  url: string;
  /** The filename the lead sees (WhatsApp shows it on documents). */
  name: string;
  /** services[].name this file is specific to; null = any treatment. */
  interest: string | null;
}

/** What the transport sends: the one shape `GhlClient.sendMessage` takes. */
export interface OutboundMedia {
  kind: MediaKind;
  url: string;
  name: string;
}

const norm = (s: string): string => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();

/** Can this channel deliver this kind at all? */
export function channelDelivers(channel: Channel, kind: MediaKind): boolean {
  if (channel === 'instagram') return kind === 'image';
  return true;
}

/**
 * The file for one slot: the row for the lead's treatment wins over the generic
 * (interest NULL) row; a row the channel can't deliver is skipped, never
 * substituted — a price sheet PDF on Instagram is a text nudge, not a wrong image.
 */
export function pickAsset(
  assets: readonly MediaAsset[],
  slot: string,
  interest: string | null | undefined,
  channel: Channel,
): MediaAsset | null {
  const want = norm(slot);
  const candidates = assets.filter((a) => norm(a.slot) === want && channelDelivers(channel, a.kind));
  if (!candidates.length) return null;
  if (interest) {
    const specific = candidates.find((a) => a.interest != null && norm(a.interest) === norm(interest));
    if (specific) return specific;
  }
  return candidates.find((a) => a.interest == null) ?? null;
}
