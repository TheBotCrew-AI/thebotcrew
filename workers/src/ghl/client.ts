/**
 * GHL API client — transport only (send message, calendar availability, booking).
 *
 * All methods are fully typed; the bodies are STUBBED until GHL specifics are
 * confirmed (endpoints + auth model). Stubs log and return safe placeholder data
 * so the runtime works end-to-end locally without touching production.
 *
 * NOTE: there is intentionally NO history-read method here — conversation
 * history comes from our own DB, never from GHL.
 */

import { getGhlEnv } from '../core/env.js';
import type {
  BookAppointmentInput,
  BookAppointmentResult,
  Slot,
} from './types.js';

export class GhlClient {
  private readonly apiBase: string;
  private readonly apiToken: string | undefined;

  constructor(token?: string) {
    const env = getGhlEnv();
    this.apiBase = env.apiBase;
    // Per-tenant token (via tenants.ghl_token_ref) overrides the agency fallback.
    this.apiToken = token ?? env.apiToken;
  }

  /** Send an outbound message to a GHL conversation. */
  async sendMessage(conversationId: string, text: string): Promise<void> {
    // TODO(GHL): POST to the conversations/messages endpoint with this.apiToken.
    console.warn(
      `[ghl:stub] sendMessage(conversation=${conversationId}) — not wired. Text: ${text.slice(0, 80)}…`,
    );
  }

  /** Get available slots for a calendar within a date range. */
  async getAvailability(calendarId: string, _from: string, _to: string): Promise<Slot[]> {
    // TODO(GHL): GET the calendar free-slots endpoint. Returning a deterministic
    // placeholder so the agent flow is testable locally.
    console.warn(`[ghl:stub] getAvailability(calendar=${calendarId}) — returning placeholder slots.`);
    return [];
  }

  /** Create an appointment in GHL. Returns the GHL appointment id. */
  async bookAppointment(input: BookAppointmentInput): Promise<BookAppointmentResult> {
    // TODO(GHL): POST to the appointments endpoint.
    console.warn(
      `[ghl:stub] bookAppointment(calendar=${input.calendarId}, contact=${input.contactId}) — not wired.`,
    );
    return { ghlAppointmentId: `stub_${input.calendarId}_${input.startTime}` };
  }
}
