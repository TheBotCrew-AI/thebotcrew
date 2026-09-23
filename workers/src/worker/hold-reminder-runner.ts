/**
 * Hold reminders — the ONE pre-deadline nudge of a paid hold (0065).
 *
 * Runs on the 5-minute cron next to the expiry runner. `app_claim_due_hold_reminders`
 * flips `reminded_at` atomically for every pending hold whose `remind_at` has come, so
 * a reminder is sent at most once and never for a hold that was paid, released or
 * cancelled in the meantime (the claim only takes `pending` rows). The text is fixed
 * (`payments/hold-messages.ts`) and repeats the short link — no model, no history.
 *
 * The time itself was decided when the hold was opened (`payments/hold-reminder.ts`);
 * this runner only honours it.
 */

import { resolveTenant } from '../core/tenant.js';
import { claimDueHoldReminders, logBotEvent } from '../db/queries.js';
import type { ClaimedHoldReminder } from '../db/types.js';
import { buildHoldReminderMessage } from '../payments/hold-messages.js';
import { paymentLinkFor } from '../payments/pay-link.js';
import { citaLabel } from './stripe-webhook-handler.js';
import { sendSystemMessage } from './system-message.js';

export interface HoldReminderResult {
  claimed: number;
  sent: number;
  skipped: number;
}

export async function runHoldReminders(limit = 20): Promise<HoldReminderResult> {
  const holds = await claimDueHoldReminders(limit);
  const result: HoldReminderResult = { claimed: holds.length, sent: 0, skipped: 0 };
  if (holds.length === 0) return result;
  console.log(`[hold-reminder] sending ${holds.length} reminder(s)`);

  for (const hold of holds) {
    try {
      (await remindOne(hold)) ? result.sent++ : result.skipped++;
    } catch (err) {
      // The claim already happened: a throw here means one lost reminder, not a
      // repeated one. Logged loudly; the deadline and the expiry cron are unaffected.
      console.error(`[hold-reminder] unhandled error hold=${hold.id}:`, err instanceof Error ? err.message : String(err));
      result.skipped++;
    }
  }
  return result;
}

async function remindOne(hold: ClaimedHoldReminder): Promise<boolean> {
  const tenant = hold.ghlLocationId ? await resolveTenant(hold.ghlLocationId) : null;
  if (!tenant || !hold.channel) {
    console.warn(`[hold-reminder] hold=${hold.id} has no active tenant or channel — skipped`);
    return false;
  }
  const [cita, deadline] = await Promise.all([
    citaLabel(tenant, hold.ghlConversationId, hold.appointmentDatetime),
    citaLabel(tenant, hold.ghlConversationId, hold.dueAt),
  ]);
  const outcome = await sendSystemMessage({
    tenant,
    ghlConversationId: hold.ghlConversationId,
    ghlContactId: hold.ghlContactId,
    channel: hold.channel,
    contactPhone: hold.contactPhone,
    text: buildHoldReminderMessage(cita, deadline, paymentLinkFor(hold)),
    tag: 'hold-reminder',
  });
  await logBotEvent(tenant.clientId, hold.ghlConversationId, 'hold_reminder_sent', {
    holdId: hold.id,
    ghlAppointmentId: hold.ghlAppointmentId,
    dueAt: hold.dueAt,
    outcome,
  });
  return outcome === 'sent';
}
