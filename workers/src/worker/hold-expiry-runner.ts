/**
 * Hold expiry runner — the 5-minute cron releases citas nobody paid for (0062).
 *
 * `app_claim_expired_holds` moves overdue pending holds to `expiring` (SKIP LOCKED),
 * then for each one: cancel the GHL event, expire the Stripe session, mark the
 * hold `expired`, log the cancellation in `appointments` (the stats layer),
 * swap the contact tags, reopen the conversation, and tell the lead the slot is
 * gone. The order is deliberate:
 *
 *   1. GHL cancel FIRST — it is the one step that must not silently fail (a cita
 *      that stays booked for free is the offer's failure mode). If it throws, the
 *      hold goes BACK to `pending` and the next tick retries, loudly (payment_error).
 *   2. `app_finish_hold('expired')` AFTER the cancel, and its `false` is honoured:
 *      it means a payment landed between the claim and now (→ paid_late, settled by
 *      the webhook). The slot is already cancelled in GHL at that point — that is
 *      the one window the two writers overlap, and it resolves as "a person
 *      reviews", never as a double state.
 *
 * Nothing here runs a model. The lead's message is a fixed sentence.
 */

import { resolveTenant } from '../core/tenant.js';
import { claimExpiredHolds, finishHold, logAppointment, logBotEvent, reactivateConversation } from '../db/queries.js';
import type { ClaimedHold } from '../db/types.js';
import { GhlClient } from '../ghl/client.js';
import { CANCELLED_APPOINTMENT_TAG, HOLD_EXPIRED_TAG, PAYMENT_PENDING_TAG } from '../ghl/tags.js';
import { buildHoldExpiredMessage } from '../payments/hold-messages.js';
import { expireCheckoutSession, getStripeEnv } from '../payments/stripe.js';
import { citaLabel } from './stripe-webhook-handler.js';
import { sendSystemMessage } from './system-message.js';

export interface HoldExpiryResult {
  claimed: number;
  expired: number;
  retried: number;
  raced: number;
}

export async function runExpiredHolds(limit = 20): Promise<HoldExpiryResult> {
  const holds = await claimExpiredHolds(limit);
  const result: HoldExpiryResult = { claimed: holds.length, expired: 0, retried: 0, raced: 0 };
  if (holds.length === 0) return result;
  console.log(`[hold-expiry] releasing ${holds.length} overdue hold(s)`);

  for (const hold of holds) {
    try {
      const outcome = await expireOne(hold);
      result[outcome]++;
    } catch (err) {
      console.error(`[hold-expiry] unhandled error hold=${hold.id}:`, err instanceof Error ? err.message : String(err));
      // Unknown failure: give the next tick a chance rather than stranding the row.
      await finishHold(hold.id, 'pending').catch(console.error);
      result.retried++;
    }
  }
  return result;
}

async function expireOne(hold: ClaimedHold): Promise<'expired' | 'retried' | 'raced'> {
  const tenant = hold.ghlLocationId ? await resolveTenant(hold.ghlLocationId) : null;
  if (!tenant) {
    // Inactive tenant: nothing to cancel on their behalf, but the hold must not stay open.
    console.error(`[hold-expiry] hold=${hold.id} has no active tenant — marking expired without GHL`);
    await finishHold(hold.id, 'expired');
    return 'expired';
  }
  const ghl = new GhlClient(tenant.tenantId);

  try {
    await ghl.cancelAppointment(hold.ghlAppointmentId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[hold-expiry] GHL cancel failed hold=${hold.id}, will retry next tick:`, msg);
    await logBotEvent(tenant.clientId, hold.ghlConversationId, 'payment_error', {
      stage: 'expire_cancel_appointment',
      holdId: hold.id,
      ghlAppointmentId: hold.ghlAppointmentId,
      error: msg,
    });
    await finishHold(hold.id, 'pending');
    return 'retried';
  }

  const env = getStripeEnv();
  if (env && hold.stripeSessionId) {
    await expireCheckoutSession(env, hold.stripeSessionId, hold.stripeAccount).catch((e: unknown) =>
      console.error('[hold-expiry] session expire failed (non-blocking):', e instanceof Error ? e.message : String(e)),
    );
  }

  const finished = await finishHold(hold.id, 'expired');
  if (!finished) {
    // A payment settled this hold while we were cancelling: it is `paid_late` now and the
    // webhook flagged it for review. The GHL cancel above already happened — that is the
    // review's job to undo, not ours to guess at.
    console.warn(`[hold-expiry] hold=${hold.id} was paid during expiry — left to the review queue`);
    return 'raced';
  }

  await logAppointment({
    p_client_id: tenant.clientId,
    p_ghl_contact_id: hold.ghlContactId,
    p_action: 'cancelled',
    p_appointment_datetime: hold.appointmentDatetime,
    p_service_type: hold.serviceType,
    p_source: 'hold-expiry',
    p_ghl_appointment_id: hold.ghlAppointmentId,
  }).catch((e: unknown) => console.error('[hold-expiry] logAppointment failed:', e instanceof Error ? e.message : String(e)));

  await Promise.all([
    ghl.addContactTags(hold.ghlContactId, [HOLD_EXPIRED_TAG, CANCELLED_APPOINTMENT_TAG]).catch((e: unknown) =>
      console.error('[hold-expiry] tag add failed:', e instanceof Error ? e.message : String(e)),
    ),
    ghl.removeContactTags(hold.ghlContactId, [PAYMENT_PENDING_TAG]).catch((e: unknown) =>
      console.error('[hold-expiry] tag removal failed:', e instanceof Error ? e.message : String(e)),
    ),
  ]);
  await logBotEvent(tenant.clientId, hold.ghlConversationId, 'hold_expired', {
    holdId: hold.id,
    ghlAppointmentId: hold.ghlAppointmentId,
    amountCents: hold.amountCents,
    currency: hold.currency,
    dueAt: hold.dueAt,
  });
  // The booking had closed the conversation (`completed`); reopen it so the bot can
  // rebook when the lead answers. Same as cancelAppointment.
  await reactivateConversation(hold.ghlConversationId).catch((e: unknown) =>
    console.error('[hold-expiry] reactivateConversation failed:', e instanceof Error ? e.message : String(e)),
  );

  if (hold.channel) {
    const label = await citaLabel(tenant, hold.ghlConversationId, hold.appointmentDatetime);
    await sendSystemMessage({
      tenant,
      ghlConversationId: hold.ghlConversationId,
      ghlContactId: hold.ghlContactId,
      channel: hold.channel,
      contactPhone: hold.contactPhone,
      text: buildHoldExpiredMessage(label),
      tag: 'hold-expiry',
    });
  }
  return 'expired';
}
