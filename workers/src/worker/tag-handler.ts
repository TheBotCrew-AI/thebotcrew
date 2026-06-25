/**
 * GHL ContactTagUpdate webhook — manual bot kill-switch via the `bot-off` tag.
 *
 * The tag is contact-scoped (no conversationId), so we resolve by ghl_contact_id:
 *   bot-off present  → handed_off (bot stays silent until the tag is removed)
 *   bot-off absent   → reactivate any handed_off conversation back to active
 *
 * No double-write loop: when the bot itself adds `bot-off` (on self-handoff),
 * GHL fires this webhook too, but the conversation is already handed_off so the
 * RPC's `status <> 'handed_off'` guard makes it a no-op.
 */

import { getGhlEnv } from '../core/env.js';
import { resolveTenant } from '../core/tenant.js';
import { logBotEvent, setBotOffByContact } from '../db/queries.js';
import { BOT_OFF_TAG } from '../ghl/tags.js';
import type { GhlContactTagWebhook } from '../ghl/types.js';
import { parseContactTagWebhook, verifyWebhook } from '../ghl/webhook.js';
import type { WebhookResult } from './webhook-handler.js';

export async function handleTagWebhook(
  payload: GhlContactTagWebhook,
  headers: Headers,
): Promise<WebhookResult> {
  const ghlEnv = getGhlEnv();
  if (!verifyWebhook(headers, ghlEnv.webhookSecret)) {
    return { status: 401, body: { error: 'invalid signature' } };
  }

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

  return { status: 200, body: { ok: true, botOff, affected } };
}
