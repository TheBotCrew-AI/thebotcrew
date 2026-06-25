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
import type { Channel } from '../core/types.js';
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

  /** Returns the GHL message ID assigned to the sent message. */
  async sendMessage(params: { contactId: string; channel: Channel; text: string; phone?: string }): Promise<{ ghlMessageId: string }> {
    const token = await this.getAccessToken();
    const ghlType = params.channel === 'instagram' ? 'IG' : params.channel === 'facebook' ? 'FB' : 'WhatsApp';
    const body: Record<string, string> = {
      type: ghlType,
      contactId: params.contactId,
      message: params.text,
    };
    if (params.phone) body.phone = params.phone;
    const res = await fetch(`${this.apiBase}/conversations/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Version: '2023-02-21',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`[ghl] sendMessage failed ${res.status}: ${detail}`);
    }
    const data = (await res.json()) as { messageId?: string; message?: { id?: string } };
    const ghlMessageId = data.messageId ?? data.message?.id ?? '';
    return { ghlMessageId };
  }

  /** Add tags to a GHL contact. Requires the `contacts.write` scope. */
  async addContactTags(contactId: string, tags: string[]): Promise<void> {
    await this.contactTags('POST', contactId, tags);
  }

  /** Remove tags from a GHL contact. Requires the `contacts.write` scope. */
  async removeContactTags(contactId: string, tags: string[]): Promise<void> {
    await this.contactTags('DELETE', contactId, tags);
  }

  private async contactTags(method: 'POST' | 'DELETE', contactId: string, tags: string[]): Promise<void> {
    if (tags.length === 0) return;
    const token = await this.getAccessToken();
    const res = await fetch(`${this.apiBase}/contacts/${contactId}/tags`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Version: '2021-07-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ tags }),
    });
    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`[ghl] ${method} contact tags failed ${res.status}: ${detail}`);
    }
  }

  /** Fetch a GHL user's name and email by their userId. Returns null on failure. */
  async getUser(ghlUserId: string): Promise<{ name: string; email?: string } | null> {
    const token = await this.getAccessToken();
    const res = await fetch(`${this.apiBase}/users/${ghlUserId}`, {
      headers: { Authorization: `Bearer ${token}`, Version: '2021-07-28' },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { name?: string; email?: string };
    return data.name ? { name: data.name, email: data.email } : null;
  }

  /** Fetch a contact's phone number from GHL. Returns undefined on failure or if absent. */
  async getContactPhone(contactId: string): Promise<string | undefined> {
    const token = await this.getAccessToken();
    const res = await fetch(`${this.apiBase}/contacts/${contactId}`, {
      headers: { Authorization: `Bearer ${token}`, Version: '2021-07-28' },
    });
    if (!res.ok) return undefined;
    const data = (await res.json()) as { contact?: { phone?: string } };
    const phone = data?.contact?.phone;
    // Reject emails and other non-phone values — GHL may store email in the phone field.
    return typeof phone === 'string' && phone && !phone.includes('@') ? phone : undefined;
  }

  async getAvailability(calendarId: string, from: string, to: string): Promise<Slot[]> {
    const token = await this.getAccessToken();
    const url = new URL(`${this.apiBase}/calendars/${calendarId}/free-slots`);
    url.searchParams.set('startDate', String(new Date(from).getTime()));
    url.searchParams.set('endDate', String(new Date(to).getTime()));

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}`, Version: '2021-04-15' },
    });
    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`[ghl] getAvailability failed ${res.status}: ${detail}`);
    }

    // GHL returns dates as top-level keys: { "2026-06-11": { slots: [...] }, traceId: "..." }
    const data = (await res.json()) as Record<string, unknown>;
    const slots: Slot[] = [];
    for (const [key, value] of Object.entries(data)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) continue; // skip traceId and other metadata
      const day = value as { slots?: string[] };
      for (const startTime of day.slots ?? []) {
        slots.push({ start: startTime, end: startTime });
      }
    }
    return slots;
  }

  async bookAppointment(input: BookAppointmentInput): Promise<BookAppointmentResult> {
    const token = await this.getAccessToken();
    const body: Record<string, unknown> = {
      calendarId: input.calendarId,
      locationId: input.locationId,
      contactId: input.contactId,
      startTime: input.startTime,
      appointmentStatus: 'confirmed',
      toNotify: true,
    };
    if (input.title) body.title = input.title;

    const res = await fetch(`${this.apiBase}/calendars/events/appointments`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Version: '2021-04-15',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`[ghl] bookAppointment failed ${res.status}: ${detail}`);
    }
    const data = (await res.json()) as { id?: string };
    return { ghlAppointmentId: data.id ?? '' };
  }
}
