/**
 * Inbound GHL webhook parsing + verification.
 *
 * NOTE(GHL): signature verification and the exact payload field names are TBD.
 * Parsing is defensive so a missing/renamed field fails closed (returns null)
 * rather than throwing.
 */

import type { Channel } from '../core/types.js';
import type { GhlInboundWebhook, ParsedInbound } from './types.js';

/** Normalize GHL's channel label to our enum. */
function normalizeChannel(raw: string | undefined): Channel {
  const v = (raw ?? '').toLowerCase();
  if (v.includes('insta') || v === 'ig') return 'instagram';
  return 'whatsapp';
}

/**
 * Verify the inbound request came from GHL.
 *
 * TODO(GHL): implement the real scheme (HMAC signature header vs shared secret)
 * once confirmed. Until then: if a secret is configured, require it; if not,
 * allow (local dev). Never silently accept in production without a secret.
 */
export function verifyWebhook(headers: Headers, secret: string | undefined): boolean {
  if (!secret) return true; // local/dev: no secret configured
  // Placeholder: GHL typically sends a signature header to validate against `secret`.
  const provided = headers.get('x-ghl-signature') ?? headers.get('x-wh-signature');
  return Boolean(provided); // TODO: replace with constant-time HMAC comparison
}

/** Extract a normalized inbound turn, or null if required fields are missing. */
export function parseInboundWebhook(payload: GhlInboundWebhook): ParsedInbound | null {
  const locationId = payload.locationId;
  const contactId = payload.contactId;
  const conversationId = payload.conversationId;
  const text = payload.body ?? payload.message;

  if (!locationId || !contactId || !conversationId || !text) {
    return null;
  }

  return {
    locationId,
    contactId,
    conversationId,
    channel: normalizeChannel(payload.messageType ?? payload.type),
    text,
    phone: payload.phone,
  };
}
