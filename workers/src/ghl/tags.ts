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
 * Tags the bot applies to the GHL contact when it sets a conversation status.
 * Additive — kept for transparency so a human can see, in GHL, what the bot did.
 */
export const STATUS_TAGS: Partial<Record<ConversationStatus, string>> = {
  handed_off: BOT_OFF_TAG,
  completed: 'bot-completed',
  opted_out: 'bot-opted-out',
  standby: 'bot-standby',
};

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
