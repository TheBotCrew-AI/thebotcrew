/**
 * Inbound GHL webhook parsing + verification.
 *
 * NOTE(GHL): signature verification and the exact payload field names are TBD.
 * Parsing is defensive so a missing/renamed field fails closed (returns null)
 * rather than throwing.
 */

import type { Channel } from '../core/types.js';
import type {
  GhlContactTagWebhook,
  GhlInboundWebhook,
  GhlOutboundWebhook,
  ParsedHumanOutbound,
  ParsedInbound,
  ParsedTagUpdate,
} from './types.js';

/** Normalize GHL's channel label to our enum. */
function normalizeChannel(raw: string | undefined): Channel {
  const v = (raw ?? '').toLowerCase();
  if (v.includes('insta') || v === 'ig') return 'instagram';
  if (v === 'fb' || v.includes('facebook')) return 'facebook';
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

/**
 * Extract a normalized human-agent outbound turn, or null if this isn't one.
 *
 * Filtering logic:
 *   source === 'api'  → our bot's own message echoed back by GHL — always skip.
 *   source === 'app'  → sent by a human via the GHL UI — process.
 *   userId absent     → defensive skip (no agent to attribute to).
 */
export function parseOutboundWebhook(payload: GhlOutboundWebhook): ParsedHumanOutbound | null {
  if (payload.type !== 'OutboundMessage' || payload.direction !== 'outbound') return null;
  if (payload.source !== 'app') return null;

  const { locationId, contactId, conversationId, body, messageId, userId } = payload;
  if (!locationId || !contactId || !conversationId || !body || !messageId || !userId) {
    return null;
  }

  const phone = typeof payload.to === 'string' && payload.to ? payload.to : undefined;
  const sentAt = payload.dateAdded ?? payload.timestamp ?? new Date().toISOString();

  return {
    locationId,
    contactId,
    conversationId,
    channel: normalizeChannel(payload.messageType),
    text: body,
    messageId,
    ghlUserId: userId,
    sentAt,
    phone,
  };
}

/** Extract a normalized inbound turn, or null if this isn't a new inbound message. */
export function parseInboundWebhook(payload: GhlInboundWebhook): ParsedInbound | null {
  // Ignore status updates, outbound echoes, and any other non-message events.
  if (payload.type !== 'InboundMessage' || payload.direction !== 'inbound') {
    return null;
  }

  const locationId = payload.locationId;
  const contactId = payload.contactId;
  const conversationId = payload.conversationId;
  const text = payload.body;

  if (!locationId || !contactId || !conversationId || !text) {
    return null;
  }

  const phone =
    typeof payload.phone === 'string' && payload.phone
      ? payload.phone
      : typeof payload.from === 'string' && payload.from
        ? payload.from
        : undefined;

  return {
    locationId,
    contactId,
    conversationId,
    channel: normalizeChannel(payload.messageType),
    text,
    phone,
    messageId: payload.messageId,
  };
}

/**
 * Extract a normalized contact tag update, or null if this isn't one.
 * GHL fires this whenever a contact's tags change; the payload carries the full
 * current tag list. Tags are lower-cased so matching is case-insensitive.
 */
export function parseContactTagWebhook(payload: GhlContactTagWebhook): ParsedTagUpdate | null {
  if (payload.type !== 'ContactTagUpdate') return null;

  const locationId = payload.locationId;
  const contactId = payload.id;
  if (!locationId || !contactId) return null;

  const tags = Array.isArray(payload.tags)
    ? payload.tags
        .filter((t): t is string => typeof t === 'string')
        .map((t) => t.trim().toLowerCase())
    : [];

  return { locationId, contactId, tags };
}
