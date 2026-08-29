/**
 * bookAppointment — create the appointment in GHL, then record it in our DB.
 * The agent must only confirm a booking AFTER this tool succeeds.
 */

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { GhlClient } from '../../../ghl/client.js';
import { CANCELLED_APPOINTMENT_TAG } from '../../../ghl/tags.js';
import { getActiveDemoSession, logAppointment, logBotEvent, logEvent, resetReactivationRound, setSimulatedBooking } from '../../../db/queries.js';
import { queueCapiEvent } from '../../../meta/capi.js';
import { resolveAgentContext } from './agent-context.js';
import { bookingQueryWindow, resolveBookableSlot } from './booking-time.js';
import { simSlotLabel, simulatedSlots } from './demo-sim.js';
import { slotLabel } from './slot-label.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export const bookAppointmentTool = createTool({
  id: 'bookAppointment',
  description:
    'Crea una cita real en el calendario para un servicio y horario. Úsala solo tras confirmar ' +
    'la disponibilidad con getAvailability. No confirmes la cita al cliente hasta que esta herramienta tenga éxito.',
  inputSchema: z.object({
    serviceName: z.string().describe('Nombre exacto del servicio'),
    startTime: z.string().describe('Fecha/hora de inicio en ISO 8601'),
    whatsappPhone: z
      .string()
      .optional()
      .describe(
        'Número de WhatsApp con código de país (ej. +526641234567) que el lead te DIO o CONFIRMÓ ' +
          'explícitamente en la conversación para recibir confirmación y recordatorios. ' +
          'Inclúyelo SOLO si el lead te lo dio/confirmó ahora; NUNCA lo extraigas del texto de un ' +
          'formulario ni lo inventes. Omítelo si el contacto ya tiene el número correcto.',
      ),
  }),
  outputSchema: z.object({
    booked: z.boolean(),
    ghlAppointmentId: z.string().optional(),
    message: z.string(),
  }),
  execute: async ({ serviceName, startTime, whatsappPhone }, ctx) => {
    const { config, tenant, turn, frameTz } = resolveAgentContext(ctx);

    // Demo mode: SIMULATED booking — same anti-hallucination guard as the real path
    // (only the exact slot string the sim returned can be "booked"), but no GHL call,
    // no appointments row, no reminder-number write. Stored on the session so
    // lookup/reschedule/cancel see it within the demo.
    if (turn.activeRole === 'demo') {
      const session = await getActiveDemoSession(turn.ghlConversationId).catch(() => null);
      const slots = simulatedSlots(turn.ghlConversationId, config.timezone, Date.now(), session?.simulatedBooking?.startTime);
      const resolved = resolveBookableSlot(slots, startTime, config.timezone);
      if (!resolved) {
        return {
          booked: false,
          message:
            'Ese horario no está disponible. Consulta de nuevo los horarios con getAvailability y ' +
            'ofrécele al lead ÚNICAMENTE uno de los slots que devuelva.',
        };
      }
      const label = simSlotLabel(resolved, config.timezone);
      if (session) {
        try {
          await setSimulatedBooking(session.id, { startTime: resolved, serviceName, label });
        } catch (e) {
          console.error('[bookAppointment] demo setSimulatedBooking failed (non-blocking):', e instanceof Error ? e.message : String(e));
        }
      }
      return { booked: true, message: `Cita confirmada: ${label}. Confírmala al lead con ese texto exacto.` };
    }

    const calendarId = config.calendars[serviceName];
    if (!calendarId) {
      return { booked: false, message: `No tengo un calendario para "${serviceName}".` };
    }

    const ghl = new GhlClient(tenant.tenantId);

    // Validate + normalize the requested time against REAL availability BEFORE anything else.
    // The model builds `startTime` and is not reliable at preserving the timezone offset (it
    // dropped the `-07:00`, which GHL read as UTC → booked 7h off: 5:15 p.m. became 10:15 a.m.).
    // So we never trust the raw string as an instant: we re-query availability and book the
    // exact, offset-correct slot string GHL returned that matches the wall-clock the lead picked.
    const now = Date.now();
    const { fromMs, toMs } = bookingQueryWindow(startTime, now);
    let canonicalStart: string;
    try {
      const slots = await ghl.getAvailability(
        calendarId,
        new Date(fromMs).toISOString(),
        new Date(toMs).toISOString(),
      );
      // Wall-clock matching happens in frameTz: the lead picked the hour off a label
      // rendered in THAT clock, so a dropped offset must be read back in the same one.
      const resolved = resolveBookableSlot(slots, startTime, frameTz);
      if (!resolved) {
        await logBotEvent(tenant.clientId, turn.ghlConversationId, 'booking_failed', {
          serviceName,
          calendarId,
          startTime,
          reason: 'slot_unavailable',
        });
        return {
          booked: false,
          message:
            'Ese horario ya no está disponible. Consulta de nuevo los horarios con getAvailability y ' +
            'ofrécele al lead ÚNICAMENTE uno de los slots que devuelva.',
        };
      }
      canonicalStart = resolved;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[bookAppointment] availability check failed:', msg);
      await logBotEvent(tenant.clientId, turn.ghlConversationId, 'booking_failed', {
        serviceName,
        calendarId,
        startTime,
        stage: 'validate_availability',
        error: msg,
      });
      return {
        booked: false,
        message: 'No pude verificar la disponibilidad en este momento. Intenta de nuevo en un momento.',
      };
    }

    // Deterministic booking horizon (business rule, per-tenant): never book past now + horizon,
    // even if GHL still offers the slot. Mirrors the clamp in getAvailability.
    const horizon = config.bookingHorizonDays ?? null;
    if (horizon != null && Date.parse(canonicalStart) > now + horizon * DAY_MS) {
      await logBotEvent(tenant.clientId, turn.ghlConversationId, 'booking_failed', {
        serviceName,
        calendarId,
        startTime: canonicalStart,
        reason: 'out_of_horizon',
        horizonDays: horizon,
      });
      return {
        booked: false,
        message:
          `Ese horario queda fuera de la ventana de agendado (${horizon} días). ` +
          'Ofrécele al lead un horario más cercano.',
      };
    }

    // Save the reminder number ONLY as part of booking (never earlier), and ONLY when the
    // contact has NO phone yet (the FB/IG case). We NEVER overwrite an existing phone:
    // changing a WhatsApp contact's number breaks the 24h messaging window — GHL/Meta treat it
    // as a new number with no lead interaction, so the bot can no longer reply (templates only).
    // A failure here is logged but does NOT block the booking.
    if (whatsappPhone) {
      const cleaned = whatsappPhone.replace(/[^\d+]/g, '');
      if (cleaned.replace(/\D/g, '').length >= 8) {
        try {
          const current = await ghl.getContactPhone(turn.ghlContactId);
          if (!current) {
            await ghl.updateContactPhone(turn.ghlContactId, cleaned);
          }
          // else: already has a number — leave it untouched (see comment above).
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error('[bookAppointment] phone save failed (non-blocking):', msg);
          await logBotEvent(tenant.clientId, turn.ghlConversationId, 'db_error', {
            stage: 'update_contact_phone',
            error: msg,
          });
        }
      }
    }

    let ghlAppointmentId: string | undefined;
    try {
      ({ ghlAppointmentId } = await ghl.bookAppointment({
        calendarId,
        locationId: tenant.ghlLocationId,
        contactId: turn.ghlContactId,
        startTime: canonicalStart,
        title: serviceName,
      }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[bookAppointment] GHL call failed:', msg);
      // Persist the GHL rejection (status + body live in msg) so a failed booking is
      // diagnosable from bot_events instead of only ephemeral Cloudflare logs.
      await logBotEvent(tenant.clientId, turn.ghlConversationId, 'booking_failed', {
        serviceName,
        calendarId,
        startTime: canonicalStart,
        error: msg,
      });
      return { booked: false, message: 'No se pudo confirmar la cita en este momento. Intenta de nuevo o contacta al equipo.' };
    }

    // Record to our stats/proof layer — fire-and-forget, don't fail the tool on log errors.
    logAppointment({
      p_client_id: tenant.clientId,
      p_ghl_contact_id: turn.ghlContactId,
      p_action: 'booked',
      p_appointment_datetime: canonicalStart,
      p_service_type: serviceName,
      p_source: 'front-desk',
      p_ghl_appointment_id: ghlAppointmentId ?? null,
    }).catch((e: unknown) => console.error('[bookAppointment] logAppointment failed:', e));
    logEvent({
      p_client_id: tenant.clientId,
      p_ghl_conversation_id: turn.ghlConversationId,
      p_event_type: 'lead_qualified',
      p_metadata: { service: serviceName, startTime: canonicalStart },
    }).catch((e: unknown) => console.error('[bookAppointment] logEvent failed:', e));
    // A real conversion wipes the ghost history (0049): while the appointment is
    // upcoming the gate keeps nudges off, and once it has passed a future silence
    // starts pursuit at round 0. A reschedule is NOT a new conversion and never resets.
    resetReactivationRound(turn.ghlConversationId).catch((e: unknown) =>
      console.error('[bookAppointment] round reset failed (non-blocking):', e instanceof Error ? e.message : String(e)),
    );
    // A new booking closes the cancellation: the contact leaves the `cita-cancelada` smart
    // list. Idempotent (removing an absent tag is a no-op in GHL) and non-blocking.
    ghl.removeContactTags(turn.ghlContactId, [CANCELLED_APPOINTMENT_TAG]).catch((e: unknown) =>
      console.error('[bookAppointment] tag removal failed (non-blocking):', e instanceof Error ? e.message : String(e)),
    );
    // Meta CAPI (0048): a real booking is the strongest lead-quality signal. Only the
    // real path reaches here (the demo short-circuit returned above) and the helper
    // no-ops for tenants without meta_capi or leads without a CTWA click id.
    void queueCapiEvent({
      tenant,
      ghlConversationId: turn.ghlConversationId,
      kind: 'appointment_booked',
      phone: turn.contactPhone ?? null,
    });

    return {
      booked: true,
      ghlAppointmentId,
      // A label, not the ISO string: the model would otherwise re-render (and, for a lead
      // in another zone, re-convert) the instant itself — the one thing it must never do.
      message: `Cita agendada: ${serviceName} el ${slotLabel(canonicalStart, frameTz, config.timezone)}. Confírmasela al lead usando EXACTAMENTE ese texto.`,
    };
  },
});
