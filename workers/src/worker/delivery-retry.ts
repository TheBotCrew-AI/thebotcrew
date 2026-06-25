/**
 * Cron retry handler for failed GHL message deliveries.
 *
 * Loads outbound bot messages that are still pending (delivery_status='pending')
 * more than 30 seconds after being logged — meaning the inline webhook retry
 * also failed — and attempts re-delivery up to 3 times total.
 *
 * Never calls the LLM; only retries stored replies.
 */

import type { Channel } from '../core/types.js';
import {
  incrementRetryCount,
  loadPendingDeliveries,
  markDelivered,
  markDeliveryFailed,
  setGhlMessageId,
} from '../db/queries.js';
import { GhlClient } from '../ghl/client.js';

export interface RetryResult {
  tried: number;
  delivered: number;
  failed: number;
}

export async function retryPendingDeliveries(): Promise<RetryResult> {
  const pending = await loadPendingDeliveries();
  let delivered = 0;
  let failed = 0;

  for (const msg of pending) {
    await incrementRetryCount(msg.messageId);

    const ghl = new GhlClient(msg.tenantId);
    let ghlMessageId: string | null = null;
    try {
      ({ ghlMessageId } = await ghl.sendMessage({
        contactId: msg.ghlContactId,
        channel: msg.channel as Channel,
        text: msg.content,
        phone: msg.contactPhone ?? undefined,
      }));
    } catch (err) {
      console.error(
        `[delivery-retry] send failed for message ${msg.messageId}:`,
        err instanceof Error ? err.message : String(err),
      );
    }

    if (ghlMessageId) {
      setGhlMessageId(msg.messageId, ghlMessageId).catch((e: unknown) => {
        console.error('[delivery-retry] setGhlMessageId failed:', e instanceof Error ? e.message : String(e));
      });
      await markDelivered(msg.messageId);
      delivered++;
    } else if (msg.retryCount + 1 >= 3) { // ghlMessageId is null → send failed
      // retryCount was the value before incrementing — now at 3, give up
      await markDeliveryFailed(msg.messageId);
      failed++;
    }
    // else: retry_count < 3, leave pending for the next cron run
  }

  return { tried: pending.length, delivered, failed };
}
