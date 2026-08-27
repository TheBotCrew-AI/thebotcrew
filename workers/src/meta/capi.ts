/**
 * Meta Conversions API — side-effectful half: enqueue from hook points + the
 * single Graph API send. The cron drain lives in worker/capi-runner.ts.
 *
 * Hook points call `queueCapiEvent` fire-and-forget-with-catch; everything that
 * can disqualify an event (feature off, kind disabled, no click id) no-ops
 * silently, so call sites stay one-liners and a tenant without meta_capi pays
 * one `if` per hook. Delivery is durable: rows land in `capi_events` and the
 * 1-minute cron drains them, so a killed isolate can't lose a conversion.
 */

import type { ConversationStatus, TenantContext } from '../core/types.js';
import { enqueueCapiEvent, getConversationCapiIdentity } from '../db/queries.js';
import {
  buildCapiEventId,
  buildCapiPayload,
  CAPI_GRAPH_VERSION,
  resolveEventSpec,
  type CapiEventKind,
  type CapiIdentity,
  type CapiMessagingChannel,
} from './capi-config.js';

/**
 * Enqueue one conversion signal for a conversation. Never throws. Pass
 * `identity` when the caller just captured it (turn 1); otherwise the stored
 * conversation value is read — a conversation with no matching key (a WhatsApp
 * lead that didn't come from a CTWA ad) produces no event.
 */
export async function queueCapiEvent(args: {
  tenant: TenantContext;
  ghlConversationId: string;
  kind: CapiEventKind;
  phone?: string | null;
  identity?: CapiIdentity;
}): Promise<void> {
  try {
    const config = args.tenant.metaCapi;
    if (!config) return;
    const spec = resolveEventSpec(config, args.kind);
    if (!spec) return;
    const identity = args.identity ?? (await getConversationCapiIdentity(args.ghlConversationId));
    if (!identity) return;

    const payload = await buildCapiPayload({ config, spec, identity, phone: args.phone });
    if (!payload) {
      // Only Instagram gets here (its account id is a config field). Loud: the lead is
      // real and the signal is lost until the operator fills instagram_business_account_id.
      console.warn(
        `[capi] ${identity.channel} lead but meta_capi lacks the account id for that channel — skipped conv=${args.ghlConversationId}`,
      );
      return;
    }
    const inserted = await enqueueCapiEvent({
      p_client_id: args.tenant.clientId,
      p_ghl_conversation_id: args.ghlConversationId,
      p_kind: args.kind,
      p_event_name: spec.name,
      p_event_id: buildCapiEventId(args.ghlConversationId, args.kind),
      p_payload: payload,
    });
    if (inserted) {
      console.log(`[capi] queued ${args.kind}→${spec.name} (${identity.channel}) conv=${args.ghlConversationId}`);
    }
  } catch (err) {
    console.error('[capi] enqueue failed (non-blocking):', err instanceof Error ? err.message : String(err));
  }
}

/**
 * Status-change hook, shared by the updateConversationStatus tool and the
 * classifier path. Only `completed` is a conversion signal — and only for
 * tenants that opted the kind in (it defaults off; see capi-config.ts).
 */
export async function queueCapiStatusEvent(
  tenant: TenantContext,
  ghlConversationId: string,
  status: ConversationStatus,
): Promise<void> {
  if (status !== 'completed') return;
  await queueCapiEvent({ tenant, ghlConversationId, kind: 'conversation_completed' });
}

export type CapiSendResult = { ok: true } | { ok: false; retryable: boolean; error: string };

/**
 * One Graph API POST. The token travels in the JSON body, never the URL, so it
 * can't leak into logs. 4xx = terminal (bad token/dataset/payload — retrying
 * the same bytes can't win); 5xx/network = retryable.
 */
export async function sendCapiEvent(args: {
  datasetId: string;
  token: string;
  testEventCode?: string;
  event: {
    event_name: string;
    event_time: number;
    event_id: string;
    action_source: 'business_messaging';
    messaging_channel: CapiMessagingChannel;
    user_data: Record<string, unknown>;
    custom_data?: Record<string, unknown>;
  };
}): Promise<CapiSendResult> {
  const body: Record<string, unknown> = {
    data: [args.event],
    access_token: args.token,
  };
  if (args.testEventCode) body.test_event_code = args.testEventCode;

  let res: Response;
  try {
    res = await fetch(`https://graph.facebook.com/${CAPI_GRAPH_VERSION}/${args.datasetId}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return { ok: false, retryable: true, error: err instanceof Error ? err.message : String(err) };
  }
  if (res.ok) return { ok: true };
  const detail = await res.text().catch(() => '');
  return {
    ok: false,
    retryable: res.status >= 500,
    error: `graph ${res.status}: ${detail.slice(0, 500)}`,
  };
}
