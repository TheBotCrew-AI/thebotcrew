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
import { getOAuthToken, getTenantGhlLocationId, upsertOAuthToken } from '../db/queries.js';
import { refreshAccessToken } from './oauth.js';
import type { BookAppointmentInput, BookAppointmentResult, Slot } from './types.js';

const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

export class GhlClient {
  private readonly apiBase: string;
  private readonly tenantId: string | undefined;
  // Cached tenant location id (null = looked up, none found; undefined = not yet looked up).
  private locationId: string | null | undefined;

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

  /** The contact id GHL currently associates with a conversation. Survives contact
   *  merges (GHL re-parents the conversation to the surviving contact), so it's how we
   *  recover when a webhook's contactId was merged away. Returns undefined on failure. */
  async getConversationContactId(conversationId: string): Promise<string | undefined> {
    const token = await this.getAccessToken();
    const res = await fetch(`${this.apiBase}/conversations/${conversationId}`, {
      headers: { Authorization: `Bearer ${token}`, Version: '2021-04-15' },
    });
    if (!res.ok) return undefined;
    const data = (await res.json()) as { contactId?: string; conversation?: { contactId?: string } };
    return data.contactId ?? data.conversation?.contactId ?? undefined;
  }

  /**
   * Send a message. Returns the GHL message ID; `resolvedContactId` is set when the
   * original contactId was stale (merged away in GHL) and we recovered the current one
   * from the conversation — the caller should persist it.
   */
  async sendMessage(params: {
    contactId: string;
    channel: Channel;
    text: string;
    phone?: string;
    email?: string;
    conversationId?: string;
  }): Promise<{ ghlMessageId: string; resolvedContactId?: string }> {
    const token = await this.getAccessToken();
    const ghlType = params.channel === 'instagram' ? 'IG' : params.channel === 'facebook' ? 'FB' : 'WhatsApp';
    const post = (contactId: string): Promise<Response> => {
      const body: Record<string, string> = { type: ghlType, contactId, message: params.text };
      if (params.phone) body.phone = params.phone;
      return fetch(`${this.apiBase}/conversations/messages`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          Version: '2023-02-21',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
    };

    let res = await post(params.contactId);
    let resolvedContactId: string | undefined;
    if (!res.ok) {
      const detail = await res.text();
      // Merge recovery: GHL dedups contacts by phone/email, which can merge away the
      // webhook's contactId (and its conversation) → send 400s CONVERSATIONS_CONTACT_NOT_FOUND.
      // Re-resolve the live (surviving) contact and retry once. Resolution order, most to
      // least reliable across a merge: phone → email (the merge keys, which the survivor
      // keeps) → the conversation object (dies with the old contact, so last resort).
      const merged = res.status === 400 && detail.includes('CONVERSATIONS_CONTACT_NOT_FOUND');
      if (merged) {
        const current =
          (await this.resolveContactByPhoneOrEmail({ phone: params.phone, email: params.email })) ??
          (params.conversationId ? await this.getConversationContactId(params.conversationId) : undefined);
        if (current && current !== params.contactId) {
          const retry = await post(current);
          if (!retry.ok) {
            const rdetail = await retry.text();
            throw new Error(`[ghl] sendMessage failed after contact re-resolve ${retry.status}: ${rdetail}`);
          }
          res = retry;
          resolvedContactId = current;
        } else {
          throw new Error(`[ghl] sendMessage failed ${res.status}: ${detail}`);
        }
      } else {
        throw new Error(`[ghl] sendMessage failed ${res.status}: ${detail}`);
      }
    }
    const data = (await res.json()) as { messageId?: string; message?: { id?: string } };
    const ghlMessageId = data.messageId ?? data.message?.id ?? '';
    return resolvedContactId ? { ghlMessageId, resolvedContactId } : { ghlMessageId };
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

  /** Write a phone number onto a GHL contact (for confirmations/reminders).
   *  Requires the `contacts.write` scope. */
  async updateContactPhone(contactId: string, phone: string): Promise<void> {
    const token = await this.getAccessToken();
    const res = await fetch(`${this.apiBase}/contacts/${contactId}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        Version: '2021-07-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ phone }),
    });
    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`[ghl] updateContactPhone failed ${res.status}: ${detail}`);
    }
  }

  /** Fetch a contact's stored name — plus its phone/email, the keys GHL merges on, so the
   *  caller can persist them and later re-resolve a merged-away contact (see
   *  resolveContactByPhoneOrEmail). Returns undefined on failure or if absent. */
  async getContact(
    contactId: string,
  ): Promise<{ firstName?: string; lastName?: string; name?: string; phone?: string; email?: string } | undefined> {
    const token = await this.getAccessToken();
    const res = await fetch(`${this.apiBase}/contacts/${contactId}`, {
      headers: { Authorization: `Bearer ${token}`, Version: '2021-07-28' },
    });
    if (!res.ok) return undefined;
    const data = (await res.json()) as {
      contact?: { firstName?: string; lastName?: string; contactName?: string; name?: string; phone?: string; email?: string };
    };
    const c = data?.contact;
    if (!c) return undefined;
    // GHL sometimes stores an email in the phone field — keep phone phone-shaped.
    const phone = typeof c.phone === 'string' && c.phone && !c.phone.includes('@') ? c.phone : undefined;
    const email = typeof c.email === 'string' && c.email.includes('@') ? c.email : undefined;
    return { firstName: c.firstName, lastName: c.lastName, name: c.name ?? c.contactName, phone, email };
  }

  /** The GHL location id for this client's tenant, resolved once and cached. Recovery
   *  searches are location-scoped; undefined when there's no tenant (agency-token path). */
  private async getLocationId(): Promise<string | undefined> {
    if (!this.tenantId) return undefined;
    if (this.locationId === undefined) {
      this.locationId = (await getTenantGhlLocationId(this.tenantId)) ?? null;
    }
    return this.locationId ?? undefined;
  }

  /** Re-resolve the live contact id after a merge, by the keys GHL dedups on: phone first,
   *  then email. A merged-away contactId 404s, but the survivor still carries the same
   *  phone/email, so an exact search finds it. Returns undefined when neither key is given
   *  or nothing matches. Requires the `contacts.readonly` scope. */
  async resolveContactByPhoneOrEmail(params: { phone?: string; email?: string }): Promise<string | undefined> {
    if (!params.phone && !params.email) return undefined;
    const token = await this.getAccessToken();
    const locationId = await this.getLocationId();
    const search = async (field: 'phone' | 'email', value: string): Promise<string | undefined> => {
      const res = await fetch(`${this.apiBase}/contacts/search`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, Version: '2021-07-28', 'Content-Type': 'application/json' },
        // locationId is included when known; a location-scoped token also infers it.
        body: JSON.stringify({
          ...(locationId ? { locationId } : {}),
          page: 1,
          pageLimit: 1,
          filters: [{ field, operator: 'eq', value }],
        }),
      });
      if (!res.ok) return undefined;
      const data = (await res.json()) as { contacts?: Array<{ id?: string }> };
      return data.contacts?.[0]?.id ?? undefined;
    };
    if (params.phone) {
      const byPhone = await search('phone', params.phone);
      if (byPhone) return byPhone;
    }
    if (params.email) {
      const byEmail = await search('email', params.email);
      if (byEmail) return byEmail;
    }
    return undefined;
  }

  /** Overwrite a GHL contact's name — used when a lead corrects a mis-saved name (e.g. the
   *  business name captured by a page form). Sends firstName + lastName together so a single
   *  first name clears the stale surname instead of leaving a "Carlos FitZone" hybrid.
   *  Requires the `contacts.write` scope. */
  async updateContactName(
    contactId: string,
    name: { firstName: string; lastName: string },
  ): Promise<void> {
    const token = await this.getAccessToken();
    const fullName = [name.firstName, name.lastName].filter(Boolean).join(' ').trim();
    const res = await fetch(`${this.apiBase}/contacts/${contactId}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        Version: '2021-07-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ firstName: name.firstName, lastName: name.lastName, name: fullName }),
    });
    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`[ghl] updateContactName failed ${res.status}: ${detail}`);
    }
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

  /** Move an existing appointment to a new time. `endTime` is optional (GHL derives from the slot). */
  async rescheduleAppointment(input: {
    appointmentId: string;
    calendarId: string;
    startTime: string;
    endTime?: string;
  }): Promise<void> {
    const token = await this.getAccessToken();
    const body: Record<string, unknown> = {
      calendarId: input.calendarId,
      startTime: input.startTime,
      appointmentStatus: 'confirmed',
      toNotify: true,
    };
    if (input.endTime) body.endTime = input.endTime;

    const res = await fetch(`${this.apiBase}/calendars/events/appointments/${input.appointmentId}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        Version: '2021-04-15',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`[ghl] rescheduleAppointment failed ${res.status}: ${detail}`);
    }
  }

  /** Fetch an appointment's live details (start time + status) from GHL. */
  async getAppointment(appointmentId: string): Promise<{ startTime?: string; status?: string; title?: string }> {
    const token = await this.getAccessToken();
    const res = await fetch(`${this.apiBase}/calendars/events/appointments/${appointmentId}`, {
      headers: { Authorization: `Bearer ${token}`, Version: '2021-04-15' },
    });
    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`[ghl] getAppointment failed ${res.status}: ${detail}`);
    }
    // GHL may wrap the object under `appointment`/`event` or return it flat — read defensively.
    const data = (await res.json()) as Record<string, unknown>;
    const appt = ((data.appointment ?? data.event ?? data) as Record<string, unknown>) ?? {};
    const asStr = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
    return {
      startTime: asStr(appt.startTime),
      status: asStr(appt.appointmentStatus) ?? asStr(appt.status),
      title: asStr(appt.title),
    };
  }

  /** A contact's appointments straight from GHL — the source of truth even for bookings the
   *  bot never made (created/edited in the GHL calendar UI, or by a human). Lets the
   *  appointment tools see appointments that were never mirrored into our store. Returns []
   *  on failure. Works with the `calendars/events.write` scope. */
  async getContactAppointments(
    contactId: string,
  ): Promise<Array<{ id: string; startTime?: string; endTime?: string; status?: string; calendarId?: string; title?: string; deleted?: boolean }>> {
    const token = await this.getAccessToken();
    const res = await fetch(`${this.apiBase}/contacts/${contactId}/appointments`, {
      headers: { Authorization: `Bearer ${token}`, Version: '2021-07-28' },
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { events?: Array<Record<string, unknown>> };
    const asStr = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
    return (data.events ?? [])
      .map((e) => ({
        id: asStr(e.id) ?? '',
        startTime: asStr(e.startTime),
        endTime: asStr(e.endTime),
        // GHL ships both `appointmentStatus` and the misspelled `appoinmentStatus` — read either.
        status: asStr(e.appointmentStatus) ?? asStr(e.appoinmentStatus),
        calendarId: asStr(e.calendarId),
        title: asStr(e.title),
        deleted: e.deleted === true,
      }))
      .filter((e) => e.id);
  }

  /** Soft-cancel an appointment (sets appointmentStatus='cancelled'; does not delete the record). */
  async cancelAppointment(appointmentId: string): Promise<void> {
    const token = await this.getAccessToken();
    const res = await fetch(`${this.apiBase}/calendars/events/appointments/${appointmentId}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        Version: '2021-04-15',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ appointmentStatus: 'cancelled', toNotify: true }),
    });
    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`[ghl] cancelAppointment failed ${res.status}: ${detail}`);
    }
  }
}
