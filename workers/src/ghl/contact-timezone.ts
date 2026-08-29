/**
 * Mirror the lead's timezone (0057) onto the GHL contact.
 *
 * The bot's own labels already read in the lead's clock; this is for the messages GHL
 * sends by itself — the tenant's appointment-confirmation / reminder workflows render
 * `{{appointment.start_time}}` in the contact's Timezone field when it is set, and in
 * the location's when it is not. Called when the zone is learned (phone guess, the
 * setLeadTimezone tool) and again right before a booking or reschedule, since that is
 * the instant `toNotify: true` fires the confirmation and the one that must not miss.
 *
 * Never throws: a contact that can't be updated costs one confirmation in the wrong
 * clock, a blocked turn costs the conversation.
 */

import type { GhlClient } from './client.js';

export async function syncContactTimezone(
  ghl: Pick<GhlClient, 'updateContactTimezone'>,
  contactId: string,
  timezone: string,
  where: string,
): Promise<boolean> {
  try {
    await ghl.updateContactTimezone(contactId, timezone);
    return true;
  } catch (err) {
    console.error(
      `[contact-timezone] sync failed (non-blocking) at ${where}:`,
      err instanceof Error ? err.message : String(err),
    );
    return false;
  }
}
