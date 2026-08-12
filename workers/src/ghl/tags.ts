/**
 * GHL tag ↔ bot-state mapping.
 *
 * `bot-off` is the human's manual kill-switch: a human adds it to a contact in
 * GHL to take a conversation over permanently; removing it hands control back.
 * Absence of the tag means the bot is on (no `bot-on` tag needed).
 *
 * The bot also writes tags when IT changes a conversation's state, so the state
 * is visible and stays in sync inside GHL.
 */

import type { ConversationStatus } from '../core/types.js';

/** Manual handoff tag. Present on a contact ⇒ bot stays silent (handed_off). */
export const BOT_OFF_TAG = 'bot-off';

/**
 * Opt-out tag. Written by the bot when the classifier reads a "stop", and since
 * 0045 also READ: removing it clears `opted_out` and lets the bot speak again.
 *
 * One-directional on purpose — adding it opts nobody out. The lead and the
 * classifier own that decision; the operator only owns undoing a wrong one.
 */
export const OPTED_OUT_TAG = 'bot-opted-out';

/**
 * Marketing opt-out (0051). The contact asked to stop receiving the GHL campaigns
 * we send OUTSIDE the bot — a different consent from `bot-opted-out` above, which
 * is about the conversation and mutes the bot. This one mutes nothing here: GHL
 * owns the campaigns and the tag, we only record the date on the conversation
 * (`marketing_opted_out_at`) so there's a track record of when consent was
 * withdrawn. Never written by the bot, only read.
 */
export const MARKETING_OPT_OUT_TAG = 'marketing-opt-out';

/**
 * Tags the bot applies to the GHL contact when it sets a conversation status.
 * Additive — kept for transparency so a human can see, in GHL, what the bot did.
 */
export const STATUS_TAGS: Partial<Record<ConversationStatus, string>> = {
  handed_off: BOT_OFF_TAG,
  completed: 'bot-completed',
  opted_out: OPTED_OUT_TAG,
  standby: 'bot-standby',
};

/**
 * Written when the FINAL reactivation round exhausts unanswered (0049): the lead
 * received every tapered pursuit they will ever get, including the farewell.
 * NOT a STATUS_TAGS entry — the conversation status written is still `standby`;
 * this is orthogonal round-state, applied only by the follow-up runner. Smart
 * lists / manual campaigns can key on it (the archive of politely-dropped leads).
 */
export const REACTIVATION_EXHAUSTED_TAG = 'reactivacion-agotada';

/**
 * Demo-session funnel tags (0038). Written on the GHL contact at each stage so
 * the funnel is visible in GHL: smart lists, and workflows can key on them
 * (e.g. "demo-iniciada 24h ago AND NOT demo-completada" → template nudge).
 * `completed` = the lead used the full message budget (a hot lead);
 * `incomplete` = the session expired or was closed early (retargeting pool).
 */
export const DEMO_SESSION_TAGS = {
  started: 'demo-iniciada',
  completed: 'demo-completada',
  incomplete: 'demo-incompleta',
} as const;

/** Map a session end reason to the funnel tag it earns. `booked` and `exhausted` both
 *  mean the lead saw the demo through; expiry/early close are the retargeting pool. */
export function demoEndTag(reason: 'exhausted' | 'expired' | 'closed' | 'booked'): string {
  return reason === 'exhausted' || reason === 'booked'
    ? DEMO_SESSION_TAGS.completed
    : DEMO_SESSION_TAGS.incomplete;
}
