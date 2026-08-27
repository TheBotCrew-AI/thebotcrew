/**
 * Cron drain for the Meta CAPI queue (0048).
 *
 * Runs on the 1-minute cron: loads pending `capi_events` rows and POSTs each to
 * the tenant's dataset. Config (token ref, test_event_code) is read FRESH from
 * the joined tenant_config each run, so a token rotation or removing the test
 * code needs no re-enqueue.
 *
 * Divergence from delivery-retry, on purpose: a MISSING token secret does not
 * consume attempts — the row stays pending (capi_error logged once) and
 * self-heals when `wrangler secret put META_CAPI_TOKEN__<SLUG>` lands. The
 * backstop is age: a row older than 48h is expired — the click id's attribution
 * value decays in days, so late delivery is worthless anyway.
 */

import { incrementCapiAttempts, loadPendingCapiEvents, logBotEvent, markCapiEvent } from '../db/queries.js';
import { parseMetaCapi, resolveCapiToken } from '../meta/capi-config.js';
import { sendCapiEvent } from '../meta/capi.js';

const MAX_ATTEMPTS = 3;
const EXPIRY_MS = 48 * 60 * 60 * 1000;
/** last_error sentinel that parks a row without consuming attempts (see above). */
const MISSING_SECRET = 'missing_token_secret';

export interface CapiRunResult {
  tried: number;
  sent: number;
  failed: number;
  skipped: number;
}

export async function runPendingCapiEvents(): Promise<CapiRunResult> {
  const pending = await loadPendingCapiEvents();
  let sent = 0;
  let failed = 0;
  let skipped = 0;

  for (const row of pending) {
    // Config deleted/broken since enqueue → the event can never be sent.
    const config = parseMetaCapi(row.metaCapi);
    if (!config) {
      await markCapiEvent(row.id, 'failed', 'tenant_capi_config_missing');
      await logBotEvent(row.clientId, row.ghlConversationId, 'capi_error', {
        stage: 'config_missing',
        kind: row.kind,
        eventId: row.eventId,
      });
      failed++;
      continue;
    }

    // Expired: the ctwa_clid attribution window is days-scale; 48h unsent = worthless.
    if (Date.now() - new Date(row.createdAt).getTime() > EXPIRY_MS) {
      await markCapiEvent(row.id, 'failed', 'expired');
      await logBotEvent(row.clientId, row.ghlConversationId, 'capi_error', {
        stage: 'expired',
        kind: row.kind,
        eventId: row.eventId,
        lastError: row.lastError,
      });
      failed++;
      continue;
    }

    // Missing secret: park (no attempt consumed), loud exactly once.
    const token = resolveCapiToken(config.tokenRef);
    if (!token) {
      if (row.lastError !== MISSING_SECRET) {
        await markCapiEvent(row.id, 'pending', MISSING_SECRET);
        console.error(
          `[capi] no Worker secret for token_ref="${config.tokenRef}" (tenant=${row.tenantId}) — rows parked until it lands`,
        );
        await logBotEvent(row.clientId, row.ghlConversationId, 'capi_error', {
          stage: MISSING_SECRET,
          tokenRef: config.tokenRef,
          kind: row.kind,
        });
      }
      skipped++;
      continue;
    }

    await incrementCapiAttempts(row.id);
    const result = await sendCapiEvent({
      datasetId: config.datasetId,
      token,
      testEventCode: config.testEventCode,
      event: {
        event_name: row.eventName,
        event_time: Math.floor(new Date(row.eventTime).getTime() / 1000),
        event_id: row.eventId,
        action_source: 'business_messaging',
        // Frozen at enqueue since 0056; rows queued before it are all WhatsApp.
        messaging_channel: row.payload.messaging_channel ?? 'whatsapp',
        user_data: row.payload.user_data,
        ...(row.payload.custom_data ? { custom_data: row.payload.custom_data } : {}),
      },
    });

    if (result.ok) {
      await markCapiEvent(row.id, 'sent');
      await logBotEvent(row.clientId, row.ghlConversationId, 'capi_event_sent', {
        kind: row.kind,
        eventName: row.eventName,
        eventId: row.eventId,
        channel: row.payload.messaging_channel ?? 'whatsapp',
        ...(config.testEventCode ? { testEventCode: config.testEventCode } : {}),
        ...(result.eventsReceived !== undefined ? { eventsReceived: result.eventsReceived } : {}),
        ...(result.messages ? { messages: result.messages } : {}),
      });
      sent++;
    } else if (!result.retryable || row.attempts + 1 >= MAX_ATTEMPTS) {
      // attempts was the value BEFORE this run's increment (mirrors delivery-retry).
      await markCapiEvent(row.id, 'failed', result.error);
      console.error(`[capi] send failed permanently event=${row.eventId}: ${result.error}`);
      await logBotEvent(row.clientId, row.ghlConversationId, 'capi_error', {
        stage: result.retryable ? 'retries_exhausted' : 'rejected',
        kind: row.kind,
        eventId: row.eventId,
        error: result.error,
      });
      failed++;
    } else {
      // Retryable and attempts remain — record the error, leave pending for the next run.
      await markCapiEvent(row.id, 'pending', result.error);
      console.error(`[capi] send failed (will retry) event=${row.eventId}: ${result.error}`);
    }
  }

  return { tried: pending.length, sent, failed, skipped };
}
