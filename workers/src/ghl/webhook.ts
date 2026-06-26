/**
 * Inbound GHL webhook parsing + RSA/Ed25519 signature verification.
 *
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

// ── Webhook signature verification ───────────────────────────────────────────
// GHL signs the RAW request body and sends one or both signature headers,
// verified against its published public keys:
//   x-ghl-signature → Ed25519       (current)
//   x-wh-signature  → RSA-SHA256     (legacy, deprecated 2026-07-01)
// Verify over the raw bytes — re-serializing the parsed JSON won't match.
// Keys from https://marketplace.gohighlevel.com/docs/webhook/WebhookIntegrationGuide

const GHL_ED25519_SPKI_B64 = 'MCowBQYDK2VwAyEAi2HR1srL4o18O8BRa7gVJY7G7bupbN3H9AwJrHCDiOg=';
const GHL_RSA_SPKI_B64 =
  'MIICIjANBgkqhkiG9w0BAQEFAAOCAg8AMIICCgKCAgEAokvo/r9tVgcfZ5DysOSCFrm602qYV0MaAiNnX9O8KxMbiyRKWeL9JpCpVpt4XHIcBOK4u3cLSqJGOLaPuXw6dO0t6Q/ZVdAV5Phz+ZtzPL16iCGeK9po6D6JHBpbi989mmzMryUnQJezlYJ3DVfBcsedpinheNnyYeFXolrJvcsjDtfAeRx5ByHQmTnSdFUzuAnC9/GepgLT9SM4nCpvuxmZMxrJt5Rw+VUaQ9B8JSvbMPpez4peKaJPZHBbU3OdeCVx5klVXXZQGNHOs8gF3kvoV5rTnXV0IknLBXlcKKAQLZcY/Q9rG6Ifi9c+5vqlvHPCUJFT5XUGG5RKgOKUJ062fRtN+rLYZUV+BjafxQauvC8wSWeYja63VSUruvmNj8xkx2zE/Juc+yjLjTXpIocmaiFeAO6fUtNjDeFVkhf5LNb59vECyrHD2SQIrhgXpO4Q3dVNA5rw576PwTzNh/AMfHKIjE4xQA1SZuYJmNnmVZLIZBlQAF9Ntd03rfadZ+yDiOXCCs9FkHibELhCHULgCsnuDJHcrGNd5/Ddm5hxGQ0ASitgHeMZ0kcIOwKDOzOU53lDza6/Y09T7sYJPQe7z0cvj7aE4B+Ax1ZoZGPzpJlZtGXCsu9aTEGEnKzmsFqwcSsnw3JB31IGKAykT1hhTiaCeIY/OwwwNUY2yvcCAwEAAQ==';

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** Local-dev escape hatch: skip verification when explicitly enabled. Off by default. */
export function webhookAuthDisabled(): boolean {
  return process.env.ALLOW_UNVERIFIED_WEBHOOKS === 'true';
}

/**
 * Verify a detached base64 signature over `rawBody` against an SPKI public key.
 * Exported for unit tests (sign a fixture with a generated keypair → round-trip).
 * Returns false on any error (bad key, unsupported algorithm, verify fail).
 */
export async function verifyDetached(
  rawBody: string,
  signatureB64: string,
  spkiB64: string,
  alg: 'ed25519' | 'rsa',
): Promise<boolean> {
  try {
    const data = new TextEncoder().encode(rawBody);
    const sig = b64ToBytes(signatureB64);
    const keyBytes = b64ToBytes(spkiB64);
    if (alg === 'ed25519') {
      const key = await crypto.subtle.importKey('spki', keyBytes, { name: 'Ed25519' }, false, ['verify']);
      return await crypto.subtle.verify({ name: 'Ed25519' }, key, sig, data);
    }
    const key = await crypto.subtle.importKey(
      'spki', keyBytes, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify'],
    );
    return await crypto.subtle.verify({ name: 'RSASSA-PKCS1-v1_5' }, key, sig, data);
  } catch {
    return false;
  }
}

/**
 * Verify a GHL webhook over its RAW body. Prefers Ed25519 (`x-ghl-signature`),
 * falls back to RSA-SHA256 (`x-wh-signature`). Fails closed: missing/invalid
 * signature ⇒ false. The fall-through is safe — both keys require GHL's private
 * keys to forge — and guards against a runtime without Ed25519 support.
 */
export async function verifyGhlWebhook(rawBody: string, headers: Headers): Promise<boolean> {
  const ed = headers.get('x-ghl-signature');
  if (ed && ed !== 'N/A' && (await verifyDetached(rawBody, ed, GHL_ED25519_SPKI_B64, 'ed25519'))) {
    return true;
  }
  const rsa = headers.get('x-wh-signature');
  if (rsa && rsa !== 'N/A' && (await verifyDetached(rawBody, rsa, GHL_RSA_SPKI_B64, 'rsa'))) {
    return true;
  }
  return false;
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
