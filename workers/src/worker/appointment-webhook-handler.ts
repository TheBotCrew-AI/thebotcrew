/**
 * GHL WORKFLOW appointment webhook — staff bookings reach our stats.
 *
 * Our `appointments` store only ever saw what the BOT booked; an appointment
 * created by staff in the GHL calendar was invisible (no Marketplace event
 * covers it). This endpoint closes that gap: each tenant configures a GHL
 * workflow ("Customer Booked Appointment" → Custom Webhook action) that POSTs
 * the IDs here, and the row lands in the store exactly like a bot booking —
 * same RPC, same `outcome='appointment_booked'`, plus the 0049 parity actions
 * (cancel pending nudges, reset the reactivation round).
 *
 * Two deliberate choices:
 * - **Auth is a shared bearer secret** (`GHL_WORKFLOW_SECRET`), not the GHL
 *   signature: workflow Custom Webhooks are unsigned — Ed25519 verification
 *   only exists for Marketplace-app events. Fails closed when the secret is
 *   unset. One platform-wide secret; the payload's locationId scopes the write
 *   to that tenant and the appointment data itself comes from GHL, not the
 *   caller, so a leaked secret can at worst insert noise rows.
 * - **Only IDs are read from the payload; the DATA comes from GHL.** The
 *   workflow action ships its default payload, whose `calendar.startTime` is a
 *   wall-clock string in the calendar's timezone with NO offset — the exact bug
 *   class that booked "5:15 p.m." as 10:15 a.m. (see tools/booking-time.ts). We
 *   ignore it and look the appointment up live (`getContactAppointments`,
 *   contacts.readonly, every tenant has it) for startTime/title.
 *
 * Payload shapes accepted (the parser reads both):
 * - GHL workflow DEFAULT payload: `location.id`, root `contact_id` (with root
 *   `phone`/`email` as a search fallback), `calendar.appointmentId`, plus an
 *   optional custom-data field `action` ('booked' default | 'rescheduled' |
 *   'cancelled') the operator adds to tell the trigger flavors apart.
 * - Explicit ids: `{locationId, contactId, appointmentId, action?}` (tests,
 *   manual replays with curl).
 */

import { resolveTenant } from '../core/tenant.js';
import type { TenantContext } from '../core/types.js';
import type { AppointmentAction } from '../db/types.js';
import {
  appointmentActionLogged,
  appointmentStatusLogged,
  cancelFollowUps,
  getLatestConversationByContact,
  logAppointment,
  logBotEvent,
  resetReactivationRound,
  setAwaitingHumanByContact,
} from '../db/queries.js';
import { GhlClient } from '../ghl/client.js';
import { CANCELLED_APPOINTMENT_TAG } from '../ghl/tags.js';
import { allowedFunnelTags, funnelPlan, normalizeFunnelStatus, parseFunnelTags, ymdInZone } from '../core/funnel-tags.js';
import type { WebhookResult } from './webhook-handler.js';

/** Actions that land in the `appointments` store (0049). */
const STORE_ACTIONS: readonly AppointmentAction[] = ['booked', 'rescheduled', 'cancelled'];
/** Status-only actions (0074): no store row, only the funnel tags. The ONE GHL workflow
 *  ("Appointment Status", any calendar) sends the status name as `action`. */
const STATUS_ACTIONS = ['confirmed', 'showed', 'noshow'] as const;
type WebhookAction = AppointmentAction | (typeof STATUS_ACTIONS)[number];
const ACTIONS: readonly WebhookAction[] = [...STORE_ACTIONS, ...STATUS_ACTIONS];

type LiveAppointment = Awaited<ReturnType<GhlClient['getContactAppointments']>>[number];

/** One attempt + one retry: GHL hiccups are short, and a lost tag is a lost smart list. */
async function withRetry<T>(what: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    console.error(`[funnel] ${what} failed, retrying:`, e instanceof Error ? e.message : String(e));
    return await fn();
  }
}

/**
 * Funnel tags (0074). Verifies the status LIVE (the workflow's `action` is a hint; GHL
 * is the truth, so a mis-wired workflow cannot mark anyone a patient), maps the
 * calendar, writes the plan in three batched calls, then records the dedupe key.
 * The key is written only after every write succeeded, so a replay can finish a
 * half-applied step; a tag already on the contact is never re-sent.
 */
async function applyFunnel(args: {
  tenant: TenantContext;
  ghl: GhlClient;
  contactId: string;
  appointmentId: string;
  live: LiveAppointment | undefined;
  hint: WebhookAction;
}): Promise<void> {
  const { tenant, ghl, contactId, appointmentId, live, hint } = args;
  const config = parseFunnelTags(tenant.config.funnelTags);
  if (!config) return;

  const conv = await getLatestConversationByContact(tenant.clientId, contactId).catch(() => null);
  const ghlConversationId = conv?.ghlConversationId ?? '';
  const fail = (reason: string, extra: Record<string, unknown> = {}) => {
    console.error(`[funnel] ${reason} appt=${appointmentId} contact=${contactId}`);
    return logBotEvent(tenant.clientId, ghlConversationId, 'funnel_error', { appointmentId, reason, hint, ...extra });
  };

  if (!live) return fail('no_live_appointment');
  const status = normalizeFunnelStatus(live.status);
  if (!status) return; // cancelled / invalid: the funnel has nothing to say
  const hinted = normalizeFunnelStatus(hint);
  if (hinted && hinted !== status) {
    console.log(`[funnel] workflow said ${hint}, GHL says ${live.status} — GHL wins appt=${appointmentId}`);
  }
  if (!live.calendarId) return fail('no_calendar_id');
  if (!live.startTime) return fail('no_start_time');

  if (await appointmentStatusLogged(tenant.clientId, appointmentId, status)) {
    console.log(`[funnel] ignored: already applied appt=${appointmentId} status=${status}`);
    return;
  }

  let currentTags: string[] = [];
  try {
    currentTags = (await ghl.getContact(contactId))?.tags ?? [];
  } catch (e) {
    console.error('[funnel] getContact failed (removals skipped):', e instanceof Error ? e.message : String(e));
  }

  const plan = funnelPlan({
    config,
    calendarId: live.calendarId,
    status,
    dateYmd: ymdInZone(live.startTime, tenant.config.timezone),
    currentTags,
  });
  if ('ignored' in plan) {
    console.warn(`[funnel] calendar not in funnel_tags map: ${live.calendarId} appt=${appointmentId} tenant=${tenant.tenantId}`);
    return;
  }
  const allowed = allowedFunnelTags(config);
  const add = plan.add.filter((t) => allowed.has(t));
  if (add.length !== plan.add.length) {
    return fail('tag_outside_allowlist', { add: plan.add });
  }

  try {
    if (add.length) await withRetry('addContactTags', () => ghl.addContactTags(contactId, add));
    if (plan.remove.length) await withRetry('removeContactTags', () => ghl.removeContactTags(contactId, plan.remove));
    if (plan.fields.length) await withRetry('updateContactCustomFields', () => ghl.updateContactCustomFields(contactId, plan.fields));
  } catch (e) {
    return fail('ghl_write_failed', { add, remove: plan.remove, fields: plan.fields, error: e instanceof Error ? e.message : String(e) });
  }

  const slug = config.calendars[live.calendarId]!.slug;
  console.log(`[funnel] ${status} ${slug} appt=${appointmentId} contact=${contactId} +[${add.join(',')}] -[${plan.remove.join(',')}] fields=${plan.fields.length}`);
  await logBotEvent(tenant.clientId, ghlConversationId, 'funnel_tagged', {
    appointmentId, status, calendarId: live.calendarId, slug, add, remove: plan.remove, fields: plan.fields,
  });
  await logBotEvent(tenant.clientId, ghlConversationId, 'appointment_status', { appointmentId, status, calendarId: live.calendarId });
}

function asTrimmed(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
}

export async function handleAppointmentWebhook(
  payload: unknown,
  authHeader: string | null,
  expectedSecret: string | undefined,
): Promise<WebhookResult> {
  // Fail closed: no secret configured = the endpoint does not exist yet.
  if (!expectedSecret || authHeader !== `Bearer ${expectedSecret}`) {
    return { status: 401, body: { error: 'unauthorized' } };
  }

  const p = (payload ?? {}) as Record<string, unknown>;
  const location = (p.location ?? {}) as Record<string, unknown>;
  const calendar = (p.calendar ?? {}) as Record<string, unknown>;
  const locationId = asTrimmed(p.locationId) ?? asTrimmed(location.id);
  let contactId = asTrimmed(p.contactId) ?? asTrimmed(p.contact_id);
  const appointmentId = asTrimmed(p.appointmentId) ?? asTrimmed(calendar.appointmentId);
  // GHL nests the webhook action's custom data under `customData` (seen 2026-10-14 on the
  // Heriberto test: `{customData: {action: 'cancelled'}}`), so a root `action` only comes
  // from manual replays. Read both; root wins.
  const customData = (p.customData ?? {}) as Record<string, unknown>;
  const action = (asTrimmed(p.action) ?? asTrimmed(customData.action) ?? 'booked') as WebhookAction;
  // What GHL actually sent: the trigger decides the payload shape, and a workflow that
  // answers 200 "ignored" is invisible otherwise (the 2026-10-14 Heriberto test).
  console.log(
    `[appt-webhook] in action=${action} location=${locationId ?? '-'} appt=${appointmentId ?? '-'} contact=${contactId ?? '-'} keys=${Object.keys(p).join(',')} calendarKeys=${Object.keys(calendar).join(',')}`,
  );
  if (!locationId || !appointmentId) {
    console.error('[appt-webhook] 400: missing locationId or appointmentId');
    return { status: 400, body: { error: 'locationId (location.id) and appointmentId (calendar.appointmentId) are required' } };
  }
  if (!ACTIONS.includes(action)) {
    console.error(`[appt-webhook] 400: unknown action=${action}`);
    return { status: 400, body: { error: `action must be one of ${ACTIONS.join('|')}` } };
  }

  const tenant = await resolveTenant(locationId);
  if (!tenant) {
    console.log(`[appt-webhook] ignored: unknown or inactive tenant location=${locationId}`);
    return { status: 200, body: { ignored: 'unknown or inactive tenant', locationId } };
  }

  const isStoreAction = (STORE_ACTIONS as readonly string[]).includes(action);
  // Dedup first (cheap, needs only the ids) — the workflow fires for BOT bookings
  // too (GHL can't tell them apart), and workflow retries re-POST. The bot's own
  // log lands milliseconds after its booking, well before any workflow delivery,
  // so id+action is a safe key. Status-only actions dedupe inside applyFunnel.
  if (isStoreAction && await appointmentActionLogged(tenant.clientId, appointmentId, action)) {
    console.log(`[appt-webhook] ignored: already logged appt=${appointmentId} action=${action}`);
    return { status: 200, body: { ignored: 'already logged', appointmentId, action } };
  }

  // The default payload should always carry root contact_id; if a GHL release
  // drops it, fall back to the same phone/email search merge-recovery uses.
  const ghl = new GhlClient(tenant.tenantId);
  if (!contactId) {
    try {
      contactId =
        (await ghl.resolveContactByPhoneOrEmail({
          phone: asTrimmed(p.phone) ?? undefined,
          email: asTrimmed(p.email) ?? undefined,
        })) ?? null;
    } catch (e) {
      console.error('[appt-webhook] contact search failed:', e instanceof Error ? e.message : String(e));
    }
  }
  if (!contactId) {
    console.error(`[appt-webhook] no contact resolvable for appt=${appointmentId} tenant=${tenant.tenantId} — stat lost`);
    return { status: 200, body: { ignored: 'no contact id and search found none', appointmentId } };
  }

  // The truth, from GHL. A miss (deleted, API hiccup) still logs the row with
  // null datetime — a stat with no time beats a booking that never counted.
  let startTime: string | null = null;
  let service: string | null = null;
  let live: LiveAppointment | undefined;
  try {
    const events = await ghl.getContactAppointments(contactId, tenant.config.timezone);
    live = events.find((e) => e.id === appointmentId);
    if (live) {
      startTime = live.startTime ?? null;
      service = live.title ?? null;
    }
  } catch (e) {
    console.error('[appt-webhook] GHL read failed (logging without datetime):', e instanceof Error ? e.message : String(e));
  }

  // Status-only actions (0074): no store row — the funnel is the whole job.
  if (!isStoreAction) {
    await applyFunnel({ tenant, ghl, contactId, appointmentId, live, hint: action });
    return { status: 200, body: { ok: true, action, appointmentId, funnel: true } };
  }

  await logAppointment({
    p_client_id: tenant.clientId,
    p_ghl_contact_id: contactId,
    p_action: action as AppointmentAction,
    p_appointment_datetime: startTime,
    p_service_type: service,
    p_source: 'ghl-workflow',
    p_ghl_appointment_id: appointmentId,
  });

  // Parity with a bot booking (0049): stop any pursuit in flight and wipe the
  // ghost history — this is what closes the "staff booking never resets the
  // round counter" gap. Non-fatal: the appointment row above is the must-have,
  // and the runner's send-time GHL check already gates nudges either way.
  let conversationId: string | null = null;
  if (action === 'booked') {
    try {
      const conv = await getLatestConversationByContact(tenant.clientId, contactId);
      if (conv) {
        conversationId = conv.id;
        await cancelFollowUps(conv.id);
        await resetReactivationRound(conv.ghlConversationId);
      }
    } catch (e) {
      console.error('[appt-webhook] booking parity failed (non-fatal):', e instanceof Error ? e.message : String(e));
    }

    // The booking IS the "I've handled this" action the awaiting-human loop waits
    // for: staff booking in the calendar used to leave the tag on until someone
    // remembered to remove it, so the conversation sat in awaiting_human and the
    // bot kept re-flagging requests the team had already resolved (the 2026-08-02
    // MADI test). Status first (load-bearing), then the GHL tag (whose removal
    // also re-drives the same flip through the tag webhook — idempotent).
    const awaitingTag = tenant.awaitingHumanTag?.trim();
    if (awaitingTag) {
      try {
        const cleared = await setAwaitingHumanByContact(contactId, false);
        if (cleared > 0) console.log(`[appt-webhook] awaiting_human cleared contact=${contactId}`);
      } catch (e) {
        console.error('[appt-webhook] awaiting_human clear failed (non-fatal):', e instanceof Error ? e.message : String(e));
      }
      ghl.removeContactTags(contactId, [awaitingTag]).catch((e: unknown) =>
        console.error('[appt-webhook] tag removal failed (non-blocking):', e instanceof Error ? e.message : String(e)),
      );
    }
  }

  // `cita-cancelada` parity with the bot's own tools: a staff cancellation tags the contact,
  // a staff booking clears it. No demo guard is needed here — a simulated demo booking never
  // reaches GHL, so the workflow never fires for it. Non-blocking, like the tag above.
  if (action === 'cancelled') {
    ghl.addContactTags(contactId, [CANCELLED_APPOINTMENT_TAG]).catch((e: unknown) =>
      console.error('[appt-webhook] cancelled tag add failed (non-blocking):', e instanceof Error ? e.message : String(e)),
    );
  } else if (action === 'booked') {
    ghl.removeContactTags(contactId, [CANCELLED_APPOINTMENT_TAG]).catch((e: unknown) =>
      console.error('[appt-webhook] cancelled tag removal failed (non-blocking):', e instanceof Error ? e.message : String(e)),
    );
  }

  // The funnel's "scheduled" step rides on the booking (0074); a cancel touches no funnel tag.
  if (action === 'booked') {
    await applyFunnel({ tenant, ghl, contactId, appointmentId, live, hint: action });
  }

  console.log(`[appt-webhook] ${action} appt=${appointmentId} contact=${contactId} tenant=${tenant.tenantId} conv=${conversationId ?? 'none'}`);
  return { status: 200, body: { ok: true, action, appointmentId, startTime } };
}
