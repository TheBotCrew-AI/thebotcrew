/**
 * GoHighLevel (GHL) types.
 *
 * GHL is the transport: it delivers inbound messages (webhook) and we send
 * outbound replies + manage the calendar through it. It is NOT our source of
 * conversation history — that lives in our own DB.
 *
 * NOTE(GHL): the exact inbound payload shape, signature scheme, and API
 * endpoints/auth are still TBD. The fields below mirror what the existing RPCs
 * already imply (ghl_conversation_id, ghl_contact_id, channel WhatsApp/IG).
 * Confirm against real GHL docs before wiring live calls.
 */

import type { Channel } from '../core/types.js';

/** Raw inbound webhook body — confirmed against real GHL payloads. */
export interface GhlInboundWebhook {
  /** 'InboundMessage' for new messages; other values (status updates, echoes) are ignored. */
  type?: string;
  locationId?: string;
  contactId?: string;
  conversationId?: string;
  /** 'inbound' | 'outbound' */
  direction?: string;
  /** 'WhatsApp' | 'IG' | 'SMS' */
  messageType?: string;
  body?: string;
  messageId?: string;
  dateAdded?: string;
  timestamp?: string;
  phone?: string;
  /** GHL sends `{}` for WhatsApp (not a phone string) — typed as unknown. */
  from?: unknown;
  to?: unknown;
  [key: string]: unknown;
}

/** Normalized inbound turn extracted from the webhook. */
export interface ParsedInbound {
  locationId: string;
  contactId: string;
  conversationId: string;
  channel: Channel;
  text: string;
  phone?: string;
  /** GHL's own message id — used for deduplication. */
  messageId?: string;
}

/** Raw outbound webhook body — sent by GHL for every message delivered to a contact. */
export interface GhlOutboundWebhook {
  type?: string;
  locationId?: string;
  contactId?: string;
  conversationId?: string;
  /** 'outbound' for all messages delivered to the contact. */
  direction?: string;
  /** 'WhatsApp' | 'IG' | 'SMS' */
  messageType?: string;
  body?: string;
  messageId?: string;
  dateAdded?: string;
  timestamp?: string;
  /** GHL user id of the human agent who sent the message. Absent on API-sent (bot) messages. */
  userId?: string;
  /** 'app' = sent by a human via the GHL UI; 'api' = sent by our bot via the API. */
  source?: string;
  /** Sender's phone number (human agent side). */
  from?: string;
  /** Recipient's phone number (contact/lead). */
  to?: string;
  contentType?: string;
  status?: string;
  [key: string]: unknown;
}

/** Normalized human-agent outbound turn extracted from the outbound webhook. */
export interface ParsedHumanOutbound {
  locationId: string;
  contactId: string;
  conversationId: string;
  channel: Channel;
  text: string;
  /** GHL message id — used for deduplication. */
  messageId: string;
  /** GHL user id of the human agent who sent the message. */
  ghlUserId: string;
  /** ISO 8601 timestamp from GHL. */
  sentAt: string;
  /** Contact's phone number (the "to" field on outbound WhatsApp). */
  phone?: string;
}

/** Raw ContactTagUpdate webhook — fired when a contact's tag field changes. Contact-scoped. */
export interface GhlContactTagWebhook {
  /** 'ContactTagUpdate' for tag changes; other values are ignored. */
  type?: string;
  locationId?: string;
  /** Contact id — GHL sends it as `id` (not `contactId`) on contact webhooks. */
  id?: string;
  /** Full current tag list on the contact after the change. */
  tags?: unknown;
  [key: string]: unknown;
}

/** Normalized tag update extracted from the webhook. */
export interface ParsedTagUpdate {
  locationId: string;
  contactId: string;
  /** Lower-cased, trimmed tag list. */
  tags: string[];
}

/** A bookable slot returned by the calendar. */
export interface Slot {
  /** ISO 8601 start time. */
  start: string;
  /** ISO 8601 end time. */
  end: string;
}

export interface BookAppointmentInput {
  calendarId: string;
  locationId: string;
  contactId: string;
  /** ISO 8601 start time. */
  startTime: string;
  title?: string;
}

export interface BookAppointmentResult {
  ghlAppointmentId: string;
}
