/**
 * booking-hold — the paid-confirmation hold shared by book / reschedule / cancel /
 * lookup (0062).
 *
 * A tenant with `booking_payment` set does not confirm a cita on the lead's word:
 * `bookAppointment` books the GHL event as `new`, opens a Stripe Checkout Session
 * for the hold amount, records the hold, and hands the model the link + deadline.
 * The webhook (`worker/stripe-webhook-handler.ts`) confirms on payment; the cron
 * (`worker/hold-expiry-runner.ts`) releases the slot when the deadline passes.
 *
 * Failure direction, deliberately: a hold WITHOUT a payment link is a free cita,
 * which is exactly what the offer forbids — so when Stripe or the hold insert
 * fails, the caller cancels the booking it just made and tells the model to retry.
 */

import type { FrontDeskConfig } from '../config.js';
import { holdAmountCents } from '../config.js';
import type { TenantContext, TurnContext } from '../../../core/types.js';
import type { GhlClient } from '../../../ghl/client.js';
import { PAYMENT_PENDING_TAG, PAYMENT_REVIEW_TAG } from '../../../ghl/tags.js';
import { createBookingHold, finishHold, getBookingHold, logBotEvent } from '../../../db/queries.js';
import { createCheckoutSession, expireCheckoutSession, getStripeEnv } from '../../../payments/stripe.js';
import { slotLabel } from './slot-label.js';

const HOUR_MS = 60 * 60 * 1000;
/** Where Checkout sends the lead afterwards — a thank-you page on the Worker, then back to WhatsApp. */
const DEFAULT_WORKER_URL = 'https://thebotcrew-agents.floral-credit-be7e.workers.dev';

export function workerBaseUrl(): string {
  return (process.env.WORKER_URL?.trim() || DEFAULT_WORKER_URL).replace(/\/+$/, '');
}

/** "$500 MXN" / "$1,250.50 MXN" — the amount as the model should say it. */
export function formatHoldAmount(amountCents: number, currency: string): string {
  const code = currency.toUpperCase();
  const whole = amountCents % 100 === 0;
  const n = new Intl.NumberFormat('es-MX', {
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(amountCents / 100);
  return `$${n} ${code}`;
}

export interface HoldOpened {
  checkoutUrl: string;
  dueAt: string;
  amountLabel: string;
  dueLabel: string;
}

/**
 * Create the Stripe session + the hold row for a cita that was JUST booked.
 * Returns the pieces the model must relay, or `{ error }` — in which case the
 * caller owns undoing the booking.
 */
export async function openBookingHold(args: {
  tenant: TenantContext;
  turn: TurnContext;
  config: FrontDeskConfig;
  ghl: GhlClient;
  ghlAppointmentId: string;
  serviceName: string;
  startTime: string;
  frameTz: string;
  now?: number;
}): Promise<HoldOpened | { error: string }> {
  const { tenant, turn, config } = args;
  const payment = config.bookingPayment;
  if (!payment) return { error: 'booking_payment_not_configured' };
  const env = getStripeEnv();
  if (!env) {
    console.error('[booking-hold] STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET missing — cannot open a hold');
    return { error: 'stripe_not_configured' };
  }
  const amountCents = holdAmountCents(config, args.serviceName);
  if (!amountCents) return { error: 'no_amount' };

  const now = args.now ?? Date.now();
  const dueAt = new Date(now + payment.holdHours * HOUR_MS);
  const base = workerBaseUrl();

  let session: { id: string; url: string };
  try {
    session = await createCheckoutSession(env, {
      amountCents,
      currency: payment.currency,
      productName: `Apartado — ${args.serviceName} · ${config.businessName}`,
      expiresAt: dueAt,
      metadata: {
        ghlAppointmentId: args.ghlAppointmentId,
        clientId: tenant.clientId,
        tenantId: tenant.tenantId,
        ghlConversationId: turn.ghlConversationId,
      },
      statementSuffix: payment.statementSuffix,
      idempotencyKey: `hold:${args.ghlAppointmentId}`,
      successUrl: `${base}/pay/ok`,
      cancelUrl: `${base}/pay/cancel`,
      now,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[booking-hold] createCheckoutSession failed:', msg);
    await logBotEvent(tenant.clientId, turn.ghlConversationId, 'payment_error', {
      stage: 'create_checkout_session',
      ghlAppointmentId: args.ghlAppointmentId,
      error: msg,
    });
    return { error: 'checkout_session_failed' };
  }

  try {
    await createBookingHold({
      p_client_id: tenant.clientId,
      p_ghl_conversation_id: turn.ghlConversationId,
      p_ghl_contact_id: turn.ghlContactId,
      p_ghl_appointment_id: args.ghlAppointmentId,
      p_service_type: args.serviceName,
      p_appointment_datetime: args.startTime,
      p_amount_cents: amountCents,
      p_currency: payment.currency,
      p_stripe_session_id: session.id,
      p_checkout_url: session.url,
      p_due_at: dueAt.toISOString(),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[booking-hold] createBookingHold failed:', msg);
    // A session nobody tracks must not stay payable: a payment on it would reach the
    // webhook with no hold to settle and the money would sit unmatched.
    await expireCheckoutSession(env, session.id).catch((e: unknown) =>
      console.error('[booking-hold] orphan session expire failed:', e instanceof Error ? e.message : String(e)),
    );
    await logBotEvent(tenant.clientId, turn.ghlConversationId, 'payment_error', {
      stage: 'create_hold_row',
      ghlAppointmentId: args.ghlAppointmentId,
      stripeSessionId: session.id,
      error: msg,
    });
    return { error: 'hold_row_failed' };
  }

  // Visible in GHL from the first second; removed on every exit. Non-blocking.
  args.ghl.addContactTags(turn.ghlContactId, [PAYMENT_PENDING_TAG]).catch((e: unknown) =>
    console.error('[booking-hold] pending tag failed (non-blocking):', e instanceof Error ? e.message : String(e)),
  );
  await logBotEvent(tenant.clientId, turn.ghlConversationId, 'hold_created', {
    ghlAppointmentId: args.ghlAppointmentId,
    stripeSessionId: session.id,
    amountCents,
    currency: payment.currency,
    dueAt: dueAt.toISOString(),
  });

  return {
    checkoutUrl: session.url,
    dueAt: dueAt.toISOString(),
    amountLabel: formatHoldAmount(amountCents, payment.currency),
    dueLabel: slotLabel(dueAt.toISOString(), args.frameTz, config.timezone),
  };
}

export type HoldRelease = 'none' | 'released' | 'paid';

/**
 * The lead cancelled the cita. A pending hold is closed (the Stripe link stops
 * working, the tag comes off); a PAID one is left as it is and flagged for a
 * person — whether the lead gets the money back is not the bot's call.
 */
export async function releaseBookingHold(args: {
  tenant: TenantContext;
  ghl: GhlClient;
  ghlContactId: string;
  ghlConversationId: string;
  ghlAppointmentId: string;
}): Promise<HoldRelease> {
  const hold = (await getBookingHold(args.ghlAppointmentId)) ?? null;
  if (!hold) return 'none';

  if (hold.status === 'paid' || hold.status === 'paid_late') {
    args.ghl.addContactTags(args.ghlContactId, [PAYMENT_REVIEW_TAG]).catch((e: unknown) =>
      console.error('[booking-hold] review tag failed (non-blocking):', e instanceof Error ? e.message : String(e)),
    );
    await logBotEvent(args.tenant.clientId, args.ghlConversationId, 'hold_released', {
      ghlAppointmentId: args.ghlAppointmentId,
      status: hold.status,
      review: true,
      reason: 'lead_cancelled',
    });
    return 'paid';
  }

  if (hold.status !== 'pending' && hold.status !== 'expiring') return 'none';

  const closed = await finishHold(hold.id, 'cancelled');
  if (!closed) {
    // The row moved under us (a payment landed between the read and this write): re-read
    // and treat it as the paid case — the cita is cancelled either way, a person reviews.
    return releaseBookingHold(args);
  }
  const env = getStripeEnv();
  if (env) {
    await expireCheckoutSession(env, hold.stripeSessionId).catch((e: unknown) =>
      console.error('[booking-hold] session expire failed (non-blocking):', e instanceof Error ? e.message : String(e)),
    );
  }
  args.ghl.removeContactTags(args.ghlContactId, [PAYMENT_PENDING_TAG]).catch((e: unknown) =>
    console.error('[booking-hold] pending tag removal failed (non-blocking):', e instanceof Error ? e.message : String(e)),
  );
  await logBotEvent(args.tenant.clientId, args.ghlConversationId, 'hold_released', {
    ghlAppointmentId: args.ghlAppointmentId,
    status: 'pending',
    reason: 'lead_cancelled',
  });
  return 'released';
}

/** One line the model can relay about a hold's payment state, or '' when there is no hold. */
export function describeHoldForModel(
  hold: { status: string; checkoutUrl: string; amountCents: number; currency: string; dueAt: string } | null,
  frameTz: string,
  tenantTz: string,
): string {
  if (!hold) return '';
  const amount = formatHoldAmount(hold.amountCents, hold.currency);
  switch (hold.status) {
    case 'pending':
    case 'expiring':
      return (
        ` La cita está APARTADA, pendiente de pago: el lead debe pagar ${amount} antes del ` +
        `${slotLabel(hold.dueAt, frameTz, tenantTz)} en esta liga: ${hold.checkoutUrl} ` +
        'Si dice que ya pagó y aquí sigue pendiente, dile que en cuanto se refleje le llega la confirmación; no la des por pagada tú.'
      );
    case 'paid':
      return ' La cita está PAGADA y confirmada.';
    case 'paid_late':
      return ' El lead pagó después de que venció el apartado: una persona del equipo lo está revisando. Díselo con naturalidad y sin prometer un resultado.';
    default:
      return ' El apartado venció o se canceló y el lugar se liberó: la liga anterior ya no sirve. Ofrécele agendar de nuevo.';
  }
}
