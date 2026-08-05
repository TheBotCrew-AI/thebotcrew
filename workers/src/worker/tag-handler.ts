/**
 * GHL ContactTagUpdate webhook — two contact-scoped tag switches.
 *
 * `bot-off` (global) — manual bot kill-switch:
 *   present → handed_off (bot stays silent until the tag is removed)
 *   absent  → reactivate any handed_off conversation back to active
 *
 * The tenant's owed-answer tags (`awaiting_human_tag`, e.g. `esperando-agenda`, and
 * `pending_info_tag`, e.g. `dato-pendiente`) — the "a person owes this lead an
 * answer" switch. They are two queues (booking vs. a fact the config lacks) but one
 * state, so they OR together:
 *   either present → awaiting_human (bot still answers; automated nudges off)
 *   both absent    → back to active, which is what re-arms follow-ups
 *
 * The second one closes the loop on the booking-by-hand flow: the owner removing
 * the tag *is* the "I've handled this" action, so it drives the state instead of
 * the model guessing when the request stops being pending.
 *
 * `bot-opted-out` (global, 0045) — the undo for a wrong opt-out:
 *   absent → clear `opted_out` back to active
 *   present → nothing. Adding it opts NOBODY out.
 * Since 0045 `opted_out` mutes the bot exactly like `handed_off`, and it is set by
 * the outcome classifier — an LLM. This tag is the only way back from a false
 * positive that doesn't involve hand-written SQL, which is why the switch is
 * one-directional: the lead's "stop" is never something an operator can assert on
 * their behalf, only something they can decide was misread.
 *
 * None of the three loops on the bot's own writes: every RPC no-ops when the
 * conversation is already in the target state, and GHL fires this webhook for
 * bot-written tags too.
 */

import { resolveTenant } from '../core/tenant.js';
import { clearOptedOutByContact, logBotEvent, setAwaitingHumanByContact, setBotOffByContact } from '../db/queries.js';
import { BOT_OFF_TAG, OPTED_OUT_TAG } from '../ghl/tags.js';
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
  // TWO tags, ONE signal. `awaiting_human_tag` (someone must book) and
  // `pending_info_tag` (we owe her a fact the config lacks, 0050) point at different
  // queues and different people, but drive the same conversation state — so the flip
  // is an OR: the lead leaves `awaiting_human` only when BOTH are gone. Clearing the
  // booking tag while a data point is still pending deliberately keeps the nudges off;
  // we still owe her an answer.
  const owedTags = [tenant.awaitingHumanTag, tenant.pendingInfoTag]
    .map((t) => t?.trim())
    .filter((t): t is string => !!t);
  if (owedTags.length > 0) {
    const awaiting = owedTags.some((t) => parsed.tags.includes(t));
    try {
      awaitingAffected = await setAwaitingHumanByContact(parsed.contactId, awaiting);
      if (awaitingAffected > 0) {
        console.log(
          `[tags] contact=${parsed.contactId} owed=[${owedTags.join(',')}]=${awaiting} affected=${awaitingAffected}`,
        );
      }
    } catch (e) {
      console.error('[tags] setAwaitingHumanByContact failed:', e instanceof Error ? e.message : String(e));
    }
  }

  // Opt-out undo. Same non-fatal treatment as the awaiting-human tag: this is a
  // correction path, and failing it must not 500 a webhook whose kill-switch half
  // already applied (GHL would retry the whole thing).
  let optOutCleared = 0;
  if (!parsed.tags.includes(OPTED_OUT_TAG)) {
    try {
      optOutCleared = await clearOptedOutByContact(parsed.contactId);
      if (optOutCleared > 0) {
        console.log(`[tags] contact=${parsed.contactId} ${OPTED_OUT_TAG} removed → cleared=${optOutCleared}`);
      }
    } catch (e) {
      console.error('[tags] clearOptedOutByContact failed:', e instanceof Error ? e.message : String(e));
    }
  }

  return { status: 200, body: { ok: true, botOff, affected, awaitingAffected, optOutCleared } };
}
