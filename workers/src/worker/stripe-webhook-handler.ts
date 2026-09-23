/**
 * Stripe webhook — a paid Checkout Session confirms its cita (0062).
 *
 * POST /webhooks/stripe, verified over the RAW body with `Stripe-Signature`
 * (fails closed: no secret configured or a bad signature → 401, nothing
 * touched). Only `checkout.session.completed` / `checkout.session.async_payment_succeeded`
 * with `payment_status = 'paid'` matter; everything else is acknowledged and
 * ignored (Stripe retries non-2xx, so an event we don't handle must still 200).
 *
 * The decision is ONE atomic SQL call (`app_settle_hold_payment`): pending →
 * paid, released → paid_late, otherwise nothing — so a replayed event, or one
 * racing the expiry cron, cannot confirm twice or resurrect a released slot.
 * Everything after settle is best-effort and LOUD (`payment_error` events): the
 * payment is real regardless, and a person can act on the `cita-pagada` /
 * `pago-revisar` tag even if one GHL call fails.
 */

import { resolveTenant } from '../core/tenant.js';
import { logBotEvent, settleHoldPayment } from '../db/queries.js';
import { GhlClient } from '../ghl/client.js';
import { PAID_APPOINTMENT_TAG, PAYMENT_PENDING_TAG, PAYMENT_REVIEW_TAG } from '../ghl/tags.js';
import { queueCapiEvent } from '../meta/capi.js';
import { buildHoldPaidLateMessage, buildHoldPaidMessage } from '../payments/hold-messages.js';
import { verifyStripeEvent, type StripeEvent } from '../payments/stripe.js';
import { slotLabel } from '../roles/front-desk/tools/slot-label.js';
import { frameTimeZone } from '../core/lead-timezone.js';
import { getConversationPersona } from '../db/queries.js';
import { sendSystemMessage } from './system-message.js';
import type { WebhookResult } from './webhook-handler.js';

const PAID_EVENTS = new Set(['checkout.session.completed', 'checkout.session.async_payment_succeeded']);

export async function handleStripeWebhook(
  rawBody: string,
  signatureHeader: string | null,
  webhookSecret: string | undefined,
  now = Date.now(),
  /** The connected-accounts endpoint's secret (Connect). Its events are signed with THIS one. */
  connectWebhookSecret?: string,
): Promise<WebhookResult> {
  if (!webhookSecret) {
    return { status: 401, body: { error: 'stripe webhook secret not configured' } };
  }
  const nowSec = Math.floor(now / 1000);
  // Two endpoints, one URL: the platform's own events and the connected accounts' events
  // arrive with different signing secrets. Try the platform's first, then Connect's — two
  // cheap HMACs. Without a Connect secret a connected account's event fails closed, loudly.
  let event = await verifyStripeEvent(rawBody, signatureHeader, webhookSecret, nowSec);
  if (!event && connectWebhookSecret) {
    event = await verifyStripeEvent(rawBody, signatureHeader, connectWebhookSecret, nowSec);
  }
  if (!event) {
    if (!connectWebhookSecret && rawBody.includes('"account"')) {
      console.error('[stripe-webhook] rejected an event that looks like a connected account\'s — STRIPE_CONNECT_WEBHOOK_SECRET not set');
    }
    return { status: 401, body: { error: 'invalid signature' } };
  }
  return processStripeEvent(event, now);
}

/** Exported for tests: the handler after signature verification. */
export async function processStripeEvent(event: StripeEvent, now = Date.now()): Promise<WebhookResult> {
  if (!PAID_EVENTS.has(event.type)) {
    return { status: 200, body: { ignored: 'event type', type: event.type } };
  }
  const session = event.data.object;
  const sessionId = typeof session.id === 'string' ? session.id : null;
  if (!sessionId) {
    return { status: 200, body: { ignored: 'no session id' } };
  }
  if (session.payment_status !== 'paid') {
    // `completed` fires for delayed methods before the money lands; the async event follows.
    return { status: 200, body: { ignored: 'not paid yet', paymentStatus: session.payment_status ?? null } };
  }
  const paymentIntent = typeof session.payment_intent === 'string' ? session.payment_intent : null;

  const hold = await settleHoldPayment(sessionId, paymentIntent);
  if (!hold) {
    // Already settled (replay), cancelled, or a session we never tracked. Nothing to do.
    return { status: 200, body: { ignored: 'no settleable hold', sessionId } };
  }

  const tenant = hold.ghlLocationId ? await resolveTenant(hold.ghlLocationId) : null;
  if (!tenant) {
    console.error(`[stripe-webhook] hold ${hold.id} paid but its tenant is unknown/inactive — money received, no tenant to confirm`);
    await logBotEvent(hold.clientId, hold.ghlConversationId, 'payment_error', {
      stage: 'resolve_tenant',
      holdId: hold.id,
      outcome: hold.outcome,
    });
    return { status: 200, body: { settled: hold.outcome, warning: 'tenant unresolved', holdId: hold.id } };
  }

  const ghl = new GhlClient(tenant.tenantId);
  const amount = hold.amountCents / 100;

  if (hold.outcome === 'paid_late') {
    // The slot was released before the money arrived. Not ours to resurrect: flag it.
    await ghl.addContactTags(hold.ghlContactId, [PAYMENT_REVIEW_TAG]).catch((e: unknown) =>
      console.error('[stripe-webhook] review tag failed:', e instanceof Error ? e.message : String(e)),
    );
    await logBotEvent(tenant.clientId, hold.ghlConversationId, 'booking_paid_late', {
      holdId: hold.id,
      ghlAppointmentId: hold.ghlAppointmentId,
      amountCents: hold.amountCents,
      currency: hold.currency,
      dueAt: hold.dueAt,
      paidAt: new Date(now).toISOString(),
      stripeEventId: event.id,
    });
    await notifyLead(tenant, hold, buildHoldPaidLateMessage(tenant.config.businessName), 'stripe-webhook');
    return { status: 200, body: { settled: 'paid_late', holdId: hold.id } };
  }

  // paid: the cita is now real. GHL first (the calendar is what the clinic reads).
  try {
    await ghl.updateAppointmentStatus(hold.ghlAppointmentId, 'confirmed');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[stripe-webhook] updateAppointmentStatus failed:', msg);
    await logBotEvent(tenant.clientId, hold.ghlConversationId, 'payment_error', {
      stage: 'confirm_appointment',
      holdId: hold.id,
      ghlAppointmentId: hold.ghlAppointmentId,
      error: msg,
    });
  }
  await Promise.all([
    ghl.addContactTags(hold.ghlContactId, [PAID_APPOINTMENT_TAG]).catch((e: unknown) =>
      console.error('[stripe-webhook] paid tag failed:', e instanceof Error ? e.message : String(e)),
    ),
    ghl.removeContactTags(hold.ghlContactId, [PAYMENT_PENDING_TAG]).catch((e: unknown) =>
      console.error('[stripe-webhook] pending tag removal failed:', e instanceof Error ? e.message : String(e)),
    ),
  ]);
  await logBotEvent(tenant.clientId, hold.ghlConversationId, 'booking_paid', {
    holdId: hold.id,
    ghlAppointmentId: hold.ghlAppointmentId,
    amountCents: hold.amountCents,
    currency: hold.currency,
    stripeEventId: event.id,
    paymentIntent,
  });
  // Money changed hands: the one event that is a Purchase, with its real value.
  await queueCapiEvent({
    tenant,
    ghlConversationId: hold.ghlConversationId,
    kind: 'appointment_paid',
    phone: hold.contactPhone,
    value: { amount, currency: hold.currency },
  });

  const label = await citaLabel(tenant, hold.ghlConversationId, hold.appointmentDatetime);
  await notifyLead(tenant, hold, buildHoldPaidMessage(label, tenant.config.businessName), 'stripe-webhook');

  return { status: 200, body: { settled: 'paid', holdId: hold.id } };
}

/** The cita's time in the lead's clock (0057) — the same label the tools render. */
export async function citaLabel(
  tenant: import('../core/types.js').TenantContext,
  ghlConversationId: string,
  appointmentDatetime: string | null,
): Promise<string> {
  if (!appointmentDatetime) return 'la fecha acordada';
  const tenantTz = tenant.config.timezone;
  let frameTz = tenantTz;
  if (tenant.config.leadTimezoneEnabled) {
    try {
      const persona = await getConversationPersona(ghlConversationId);
      frameTz = frameTimeZone({ leadTimezoneEnabled: true, timezone: tenantTz }, { leadTimezone: persona.leadTimezone ?? undefined });
    } catch (e) {
      console.error('[hold] lead timezone read failed, using tenant clock:', e instanceof Error ? e.message : String(e));
    }
  }
  return slotLabel(appointmentDatetime, frameTz, tenantTz);
}

async function notifyLead(
  tenant: import('../core/types.js').TenantContext,
  hold: { ghlConversationId: string; ghlContactId: string; channel: string | null; contactPhone: string | null },
  text: string,
  tag: string,
): Promise<void> {
  if (!hold.channel) {
    console.error(`[${tag}] no conversation channel for conv=${hold.ghlConversationId} — lead not messaged`);
    return;
  }
  await sendSystemMessage({
    tenant,
    ghlConversationId: hold.ghlConversationId,
    ghlContactId: hold.ghlContactId,
    channel: hold.channel,
    contactPhone: hold.contactPhone,
    text,
    tag,
  });
}
