/**
 * cancelAppointment — soft-cancel the contact's active appointment in GHL, record
 * it, and reopen the conversation so the bot can offer to rebook.
 *
 * The agent must confirm the intent explicitly with the lead BEFORE calling this
 * (see the prompt rules) — never cancel on an ambiguous message.
 */

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { GhlClient } from '../../../ghl/client.js';
import { CANCELLED_APPOINTMENT_TAG } from '../../../ghl/tags.js';
import { getActiveDemoSession, getBookingHold, logAppointment, logBotEvent, reactivateConversation, setSimulatedBooking } from '../../../db/queries.js';
import { resolveAgentContext } from './agent-context.js';
import { releaseBookingHold } from './booking-hold.js';
import { resolveActiveAppointment } from './resolve-appointment.js';

export const cancelAppointmentTool = createTool({
  id: 'cancelAppointment',
  description:
    'Cancela la cita activa del contacto en el calendario. Úsala SOLO después de que el lead confirmó ' +
    'explícitamente que quiere cancelar. Si no hay una cita activa, lo indica sin inventar.',
  inputSchema: z.object({}),
  outputSchema: z.object({
    cancelled: z.boolean(),
    message: z.string(),
  }),
  execute: async (_input, ctx) => {
    const { tenant, turn, config } = resolveAgentContext(ctx);

    // Demo mode: clear the session's simulated booking; never touch GHL or the store.
    if (turn.activeRole === 'demo') {
      const session = await getActiveDemoSession(turn.ghlConversationId).catch(() => null);
      if (!session?.simulatedBooking) {
        return { cancelled: false, message: 'No encuentro una cita activa para cancelar.' };
      }
      try {
        await setSimulatedBooking(session.id, null);
      } catch (e) {
        console.error('[cancelAppointment] demo clear failed (non-blocking):', e instanceof Error ? e.message : String(e));
      }
      return { cancelled: true, message: 'Cita cancelada. Ofrece agendar otro horario si el lead quiere.' };
    }

    const ghl = new GhlClient(tenant.tenantId);
    const appt = await resolveActiveAppointment(ghl, tenant.clientId, turn.ghlContactId, Date.now());
    if (!appt) {
      return { cancelled: false, message: 'No encuentro una cita activa para cancelar.' };
    }

    // Paid confirmation (0062): a PAID cita is not cancelled by the bot — the platform's
    // rule, and the lead was told before choosing a slot. It can be moved. Decided here,
    // not left to the prompt, so a persuasive lead can't talk the model into it; the
    // refund question is a person's, and only after a reschedule was offered.
    if (config.bookingPayment) {
      const hold = (await getBookingHold(appt.ghlAppointmentId).catch(() => null)) ?? null;
      if (hold && (hold.status === 'paid' || hold.status === 'paid_late')) {
        await logBotEvent(tenant.clientId, turn.ghlConversationId, 'booking_failed', {
          stage: 'cancel',
          reason: 'paid_hold',
          ghlAppointmentId: appt.ghlAppointmentId,
        });
        return {
          cancelled: false,
          message:
            'La cita YA está pagada y una cita pagada no se cancela: sigue apartada a su nombre. Díselo con calidez y en positivo ' +
            '(sin hablar de devoluciones ni de políticas), y ofrécele moverla a otro horario: llama getAvailability y dale dos opciones reales. ' +
            'Si insiste en cancelar, dile que con gusto le apoyas a reagendar cuando quiera y que el lugar queda suyo.',
        };
      }
    }

    try {
      await ghl.cancelAppointment(appt.ghlAppointmentId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[cancelAppointment] GHL call failed:', msg);
      await logBotEvent(tenant.clientId, turn.ghlConversationId, 'booking_failed', {
        stage: 'cancel',
        ghlAppointmentId: appt.ghlAppointmentId,
        error: msg,
      });
      return { cancelled: false, message: 'No se pudo cancelar la cita en este momento. Intenta de nuevo o contacta al equipo.' };
    }

    // Record to our stats/proof layer — fire-and-forget.
    logAppointment({
      p_client_id: tenant.clientId,
      p_ghl_contact_id: turn.ghlContactId,
      p_action: 'cancelled',
      p_appointment_datetime: appt.startTime,
      p_service_type: appt.serviceType,
      p_source: 'front-desk',
      p_ghl_appointment_id: appt.ghlAppointmentId,
    }).catch((e: unknown) => console.error('[cancelAppointment] logAppointment failed:', e));

    // Reopen the conversation (booking had set it 'completed') so the bot can offer to rebook.
    reactivateConversation(turn.ghlConversationId).catch((e: unknown) =>
      console.error('[cancelAppointment] reactivateConversation failed:', e),
    );

    // Make the cancellation visible in GHL (smart lists / reactivation campaigns). Fire-and-
    // forget: a tag failure must never turn a cancellation that already happened into an
    // error the model then reports to the lead. The demo path returned above, so a simulated
    // cancel never tags a real contact.
    ghl.addContactTags(turn.ghlContactId, [CANCELLED_APPOINTMENT_TAG]).catch((e: unknown) =>
      console.error('[cancelAppointment] tag add failed (non-blocking):', e instanceof Error ? e.message : String(e)),
    );

    // Paid confirmation (0062): close the hold. A paid one is a person's decision (refund
    // or rebook) — the bot only makes sure it is flagged and says so without promising.
    let release: Awaited<ReturnType<typeof releaseBookingHold>> = 'none';
    if (config.bookingPayment) {
      release = await releaseBookingHold({
        tenant, ghl, ghlContactId: turn.ghlContactId, ghlConversationId: turn.ghlConversationId, ghlAppointmentId: appt.ghlAppointmentId,
      }).catch((e: unknown) => {
        console.error('[cancelAppointment] releaseBookingHold failed:', e instanceof Error ? e.message : String(e));
        return 'none' as const;
      });
    }

    return {
      cancelled: true,
      message:
        release === 'paid'
          ? 'Cita cancelada. El lead YA había pagado el apartado: una persona del equipo revisa qué procede (devolución o reagendar). Díselo con naturalidad, sin prometer plazos ni montos.'
          : 'Cita cancelada.',
    };
  },
});
