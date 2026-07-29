/**
 * GHL ContactTagUpdate webhook — two contact-scoped tag switches.
 *
 * `bot-off` (global) — manual bot kill-switch:
 *   present → handed_off (bot stays silent until the tag is removed)
 *   absent  → reactivate any handed_off conversation back to active
 *
 * The tenant's `awaiting_human_tag` (per-tenant, e.g. `esperando-agenda`) — the
 * "a person owes this lead an answer" switch:
 *   present → awaiting_human (bot still answers; automated nudges off)
 *   absent  → back to active, which is what re-arms follow-ups
 *
 * The second one closes the loop on the booking-by-hand flow: the owner removing
 * the tag *is* the "I've handled this" action, so it drives the state instead of
 * the model guessing when the request stops being pending.
 *
 * Neither loops on the bot's own writes: both RPCs no-op when the conversation is
 * already in the target state, and GHL fires this webhook for bot-written tags too.
 */

import { resolveTenant } from '../core/tenant.js';
import { logBotEvent, setAwaitingHumanByContact, setBotOffByContact } from '../db/queries.js';
import { BOT_OFF_TAG } from '../ghl/tags.js';
import type { GhlContactTagWebhook } from '../ghl/types.js';
import { parseContactTagWebhook } from '../ghl/webhook.js';
import type { WebhookResult } from './webhook-handler.js';

export async function handleTagWebhook(
  payload: GhlContactTagWebhook,
): Promise<WebhookResult> {
  // Signature already verified at the route handler (raw body, before parse).
  const parsed = parseContactTagWebhook(payload);
  if (!parsed) {
    return { status: 200, body: { ignored: 'not a contact tag update' } };
  }

  const tenant = await resolveTenant(parsed.locationId);
  if (!tenant) {
    return { status: 200, body: { ignored: 'unknown or inactive tenant', locationId: parsed.locationId } };
  }

  const botOff = parsed.tags.includes(BOT_OFF_TAG);

  let affected = 0;
  try {
    affected = await setBotOffByContact(parsed.contactId, botOff);
  } catch (e) {
    console.error('[tags] setBotOffByContact failed:', e instanceof Error ? e.message : String(e));
    return { status: 500, body: { error: 'tag_handoff_failed' } };
  }

  if (affected > 0) {
    // Awaited: this route has no waitUntil, so a detached write would be dropped.
    await logBotEvent(tenant.clientId, '', botOff ? 'handoff_tag_on' : 'handoff_tag_off', {
      contactId: parsed.contactId,
      affected,
    });
    console.log(`[tags] contact=${parsed.contactId} bot-off=${botOff} affected=${affected}`);
  }

  // Per-tenant awaiting-human tag. Only for tenants that configured one; everyone
  // else skips this entirely. Non-fatal: the bot-off switch above is the critical
  // one, so a failure here must not turn the whole webhook into a 500 and make GHL
  // retry a kill-switch that already applied.
  let awaitingAffected = 0;
  const awaitingTag = tenant.awaitingHumanTag?.trim();
  if (awaitingTag) {
    const awaiting = parsed.tags.includes(awaitingTag);
    try {
      awaitingAffected = await setAwaitingHumanByContact(parsed.contactId, awaiting);
      if (awaitingAffected > 0) {
        console.log(`[tags] contact=${parsed.contactId} ${awaitingTag}=${awaiting} affected=${awaitingAffected}`);
      }
    } catch (e) {
      console.error('[tags] setAwaitingHumanByContact failed:', e instanceof Error ? e.message : String(e));
    }
  }

  return { status: 200, body: { ok: true, botOff, affected, awaitingAffected } };
}
