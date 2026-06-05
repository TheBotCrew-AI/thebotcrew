/**
 * GHL API client — transport only (send message, calendar availability, booking).
 *
 * Constructed with a tenantId; fetches the per-tenant OAuth token from
 * `ghl_oauth_tokens` and auto-refreshes it when within 5 minutes of expiry.
 * Falls back to the agency token (GHL_API_TOKEN) if no OAuth token is stored yet.
 *
 * API method bodies are STUBBED until GHL endpoints are confirmed.
 * TODO(GHL): wire sendMessage, getAvailability, bookAppointment once confirmed.
 */

import { getGhlEnv } from '../core/env.js';
import { getOAuthToken, upsertOAuthToken } from '../db/queries.js';
import { refreshAccessToken } from './oauth.js';
import type { BookAppointmentInput, BookAppointmentResult, Slot } from './types.js';

const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

export class GhlClient {
  private readonly apiBase: string;
  private readonly tenantId: string | undefined;

  constructor(tenantId?: string) {
    this.apiBase = getGhlEnv().apiBase;
    this.tenantId = tenantId;
  }

  private async getAccessToken(): Promise<string | undefined> {
    if (!this.tenantId) {
      return getGhlEnv().apiToken;
    }

    const stored = await getOAuthToken(this.tenantId);
    if (!stored) {
      console.warn(`[ghl] no OAuth token for tenant ${this.tenantId} — falling back to agency token`);
      return getGhlEnv().apiToken;
    }

    const expiresAt = new Date(stored.expires_at).getTime();
    if (Date.now() >= expiresAt - TOKEN_REFRESH_BUFFER_MS) {
      try {
        const fresh = await refreshAccessToken(stored.refresh_token);
        await upsertOAuthToken(this.tenantId, fresh);
        return fresh.access_token;
      } catch (err) {
        console.error(`[ghl] token refresh failed for tenant ${this.tenantId}:`, err);
        return stored.access_token;
      }
    }

    return stored.access_token;
  }

  async sendMessage(conversationId: string, text: string): Promise<void> {
    const _token = await this.getAccessToken();
    // TODO(GHL): POST to the conversations/messages endpoint.
    console.warn(
      `[ghl:stub] sendMessage(conversation=${conversationId}) — not wired. Text: ${text.slice(0, 80)}…`,
    );
  }

  async getAvailability(calendarId: string, _from: string, _to: string): Promise<Slot[]> {
    const _token = await this.getAccessToken();
    // TODO(GHL): GET the calendar free-slots endpoint.
    console.warn(`[ghl:stub] getAvailability(calendar=${calendarId}) — returning placeholder slots.`);
    return [];
  }

  async bookAppointment(input: BookAppointmentInput): Promise<BookAppointmentResult> {
    const _token = await this.getAccessToken();
    // TODO(GHL): POST to the appointments endpoint.
    console.warn(
      `[ghl:stub] bookAppointment(calendar=${input.calendarId}, contact=${input.contactId}) — not wired.`,
    );
    return { ghlAppointmentId: `stub_${input.calendarId}_${input.startTime}` };
  }
}
