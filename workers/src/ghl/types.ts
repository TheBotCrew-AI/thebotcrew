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

/** Raw inbound webhook body (permissive — real shape TBD). */
export interface GhlInboundWebhook {
  locationId?: string;
  contactId?: string;
  conversationId?: string;
  /** GHL channel/message type, e.g. 'WhatsApp' | 'IG' | 'SMS'. */
  messageType?: string;
  type?: string;
  /** Message text under one of GHL's known keys. */
  body?: string;
  message?: string;
  phone?: string;
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
  contactId: string;
  /** ISO 8601 start time. */
  startTime: string;
  title?: string;
}

export interface BookAppointmentResult {
  ghlAppointmentId: string;
}
