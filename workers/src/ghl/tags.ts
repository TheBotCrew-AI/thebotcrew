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
