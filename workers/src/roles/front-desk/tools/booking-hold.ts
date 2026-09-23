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
 * The link the model relays is the SHORT one (0063, `payments/pay-link.ts`): Stripe's
 * URL stays in the row and the Worker redirects to it. The deadline is the sooner of
 * now + holdHours and cita − deadlineMarginHours: a payment window that closes after
 * the cita is no window at all.
 *
 * Failure direction, deliberately: a hold WITHOUT a payment link is a free cita,
 * which is exactly what the offer forbids — so when Stripe or the hold insert
 * fails, the caller cancels the booking it just made and tells the model to retry.
 */

import type { BookingPaymentConfig, FrontDeskConfig } from '../config.js';
import { holdAmountCents } from '../config.js';
import type { TenantContext, TurnContext } from '../../../core/types.js';
import type { GhlClient } from '../../../ghl/client.js';
import { PAYMENT_PENDING_TAG, PAYMENT_REVIEW_TAG } from '../../../ghl/tags.js';
import { createBookingHold, finishHold, getBookingHold, logBotEvent } from '../../../db/queries.js';
import { CHECKOUT_MIN_EXPIRY_MS, createCheckoutSession, expireCheckoutSession, getStripeEnv } from '../../../payments/stripe.js';
import { newShortCode, payLinkUrl, paymentLinkFor, workerBaseUrl } from '../../../payments/pay-link.js';
import { slotLabel } from './slot-label.js';

export { workerBaseUrl };

const HOUR_MS = 60 * 60 * 1000;

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

/**
 * When the payment must be in, in ms: the sooner of now + holdHours and cita − margin.
 * null when that instant is closer than Stripe's 30-minute session minimum — the cita is
 * too soon to be paid for, and the caller refuses BEFORE booking rather than book + undo.
 */
export function holdDeadlineMs(now: number, appointmentStartMs: number, payment: Pick<BookingPaymentConfig, 'holdHours' | 'deadlineMarginHours'>): number | null {
  const byHold = now + payment.holdHours * HOUR_MS;
  const byCita = appointmentStartMs - payment.deadlineMarginHours * HOUR_MS;
  const deadline = Math.min(byHold, byCita);
  return deadline - now < CHECKOUT_MIN_EXPIRY_MS ? null : deadline;
}

/** The earliest cita start a hold can be opened for: now + margin + Stripe's minimum. */
export function earliestPayableStartMs(now: number, payment: Pick<BookingPaymentConfig, 'deadlineMarginHours'>): number {
  return now + payment.deadlineMarginHours * HOUR_MS + CHECKOUT_MIN_EXPIRY_MS;
}

/** "2 h" / "30 min" / "1.5 h" — the notice a payable cita needs, as the tool says it. */
export function payableNoticeLabel(payment: Pick<BookingPaymentConfig, 'deadlineMarginHours'>): string {
  const minutes = Math.round(payment.deadlineMarginHours * 60 + CHECKOUT_MIN_EXPIRY_MS / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = minutes / 60;
  return `${Number.isInteger(hours) ? hours : hours.toFixed(1)} h`;
}

export interface HoldOpened {
  /** The SHORT link the lead pays at — never Stripe's URL. */
  paymentUrl: string;
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
  const deadlineMs = holdDeadlineMs(now, Date.parse(args.startTime), payment);
  if (deadlineMs == null) return { error: 'too_soon_to_pay' };
  const dueAt = new Date(deadlineMs);
  const base = workerBaseUrl();
  const shortCode = newShortCode();

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
      p_short_code: shortCode,
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
    shortCode,
    amountCents,
    currency: payment.currency,
    dueAt: dueAt.toISOString(),
  });

  return {
    paymentUrl: payLinkUrl(base, shortCode),
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

/**
 * What the model relays about a hold's payment state, or '' when there is no hold.
 * The link, when there is one, is the LAST thing in the string and sits alone on its
 * own line: the 2026-09-22 reply pasted the link and then everything that followed it
 * in the note, verbatim — so nothing follows it.
 */
export function describeHoldForModel(
  hold: { status: string; checkoutUrl: string; shortCode?: string | null; amountCents: number; currency: string; dueAt: string } | null,
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
        `${slotLabel(hold.dueAt, frameTz, tenantTz)}. ` +
        'Si dice que ya pagó y aquí sigue pendiente, dile que en cuanto se refleje le llega la confirmación; no la des por pagada tú. ' +
        'Si dice que la liga no abre, que no le llegó o te la pide de nuevo, mándasela otra vez tal cual, sola al final de tu mensaje y en su propio renglón. ' +
        `La liga de pago es la que sigue y nada más:\n${paymentLinkFor(hold)}`
      );
    case 'paid':
      return ' La cita está PAGADA y confirmada. Una cita pagada no se cancela: si necesita cambiarla, se reagenda.';
    case 'paid_late':
      return ' El lead pagó después de que venció el apartado: una persona del equipo lo está revisando. Díselo con naturalidad y sin prometer un resultado.';
    default:
      return ' El apartado venció o se canceló y el lugar se liberó: la liga anterior ya no sirve. Ofrécele agendar de nuevo.';
  }
}
