/**
 * getAvailability — fetch real calendar slots for a service via GHL.
 * The agent must call this before offering or confirming any time.
 */

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { GhlClient } from '../../../ghl/client.js';
import { getActiveDemoSession, logBotEvent } from '../../../db/queries.js';
import { resolveAgentContext } from './agent-context.js';
import { earliestPayableStartMs, payableNoticeLabel } from './booking-hold.js';
import { resolveBookingWindow } from './booking-window.js';
import { simulatedSlots } from './demo-sim.js';
import { closedRange, dayListEs, openDaysEs } from './open-days.js';
import { slotLabel } from './slot-label.js';

export const getAvailabilityTool = createTool({
  id: 'getAvailability',
  description:
    'Consulta los horarios disponibles reales para un servicio. Devuelve slots concretos; ' +
    'nunca ofrezcas horarios sin consultarlos aquí primero.',
  inputSchema: z.object({
    serviceName: z.string().describe('Nombre exacto del servicio (debe coincidir con los configurados)'),
    fromDate: z.string().optional().describe('Fecha/hora ISO 8601 de inicio del rango (por defecto: ahora)'),
    toDate: z.string().optional().describe('Fecha/hora ISO 8601 de fin del rango (por defecto: +7 días)'),
  }),
  outputSchema: z.object({
    slots: z.array(z.object({ start: z.string(), end: z.string(), label: z.string() })),
    note: z.string().optional(),
  }),
  execute: async ({ serviceName, fromDate, toDate }, ctx) => {
    const { tenant, turn, config, frameTz } = resolveAgentContext(ctx);

    // Demo mode: SIMULATED slots — no GHL call (nothing can fail in front of a
    // prospect), no real calendar involved. Deterministic per conversation+day so
    // re-queries agree; the already-simulated booking is excluded like a real hold.
    if (turn.activeRole === 'demo') {
      const session = await getActiveDemoSession(turn.ghlConversationId).catch(() => null);
      const slots = simulatedSlots(
        turn.ghlConversationId,
        config.timezone,
        Date.now(),
        session?.simulatedBooking?.startTime,
      );
      await logBotEvent(tenant.clientId, turn.ghlConversationId, 'availability_checked', {
        serviceName,
        demo: true,
        slotCount: slots.length,
      });
      return {
        slots,
        note:
          'Ofrece MÁXIMO 3 de estos horarios, en un solo mensaje corto y sin lista con viñetas. ' +
          'Usa EXACTAMENTE el texto del campo "label" de los que menciones (ya trae el día correcto). No recalcules ni traduzcas fechas.',
      };
    }

    const calendarId = config.calendars[serviceName];
    if (!calendarId) {
      await logBotEvent(tenant.clientId, turn.ghlConversationId, 'availability_checked', {
        serviceName,
        calendarId: null,
        outcome: 'no_calendar_configured',
      });
      return {
        slots: [],
        note: `No hay un calendario configurado para "${serviceName}".`,
      };
    }

    // Format each slot's day/time in code (correct weekday, in the clock the LEAD reads —
    // frameTz — with a "hora de …" suffix when that differs from the calendar's), so the
    // agent presents them verbatim and never computes or converts a date itself.
    const label = (iso: string): string => slotLabel(iso, frameTz, config.timezone);

    // Deterministic booking horizon (business rule, per-tenant): the tool never looks
    // past now + bookingHorizonDays. Does NOT rely on the model behaving — the range is
    // clamped here, or (if it starts entirely beyond the horizon) we return that fact so
    // the agent redirects the lead to the valid window.
    const horizon = config.bookingHorizonDays ?? null;
    // Minimum notice (near side, same idea): with 1 day nothing before local midnight of
    // tomorrow is queried, so a same-day slot is never on the board. The day boundary is the
    // TENANT's calendar day — it is the business that opens tomorrow, not the lead.
    const minNotice = config.bookingMinNoticeDays ?? null;
    // Paid confirmation (0063): a slot the lead couldn't pay for before the cita is never
    // on the board — offering it and then refusing it in bookAppointment is the bad turn.
    const payFloorMs = config.bookingPayment ? earliestPayableStartMs(Date.now(), config.bookingPayment) : null;
    // The model types fromDate/toDate in the clock it reads, so they're interpreted in frameTz.
    const window = resolveBookingWindow(Date.now(), fromDate, toDate, horizon, frameTz, minNotice, payFloorMs);

    if (window.tooSoonToPay && payFloorMs != null && config.bookingPayment) {
      const notice = payableNoticeLabel(config.bookingPayment);
      await logBotEvent(tenant.clientId, turn.ghlConversationId, 'availability_checked', {
        serviceName,
        calendarId,
        from: new Date(window.fromMs).toISOString(),
        to: new Date(window.toMs).toISOString(),
        outcome: 'too_soon_to_pay',
        deadlineMarginHours: config.bookingPayment.deadlineMarginHours,
      });
      return {
        slots: [],
        note:
          `Ese rango ya está demasiado cerca para alcanzar a pagar el apartado: se necesitan al menos ${notice} de anticipación, ` +
          `así que los horarios empiezan a partir del ${label(new Date(payFloorMs).toISOString())}. ` +
          'Díselo al lead en positivo y con calidez —que tan pronto ya no alcanza a apartarse, pero un poco más tarde sí— y consulta de nuevo desde esa hora para ofrecerle horarios concretos.',
      };
    }

    if (window.tooSoon && window.minMs != null) {
      const minLabel = label(new Date(window.minMs).toISOString());
      await logBotEvent(tenant.clientId, turn.ghlConversationId, 'availability_checked', {
        serviceName,
        calendarId,
        from: new Date(window.fromMs).toISOString(),
        to: new Date(window.toMs).toISOString(),
        outcome: 'too_soon',
        minNoticeDays: minNotice,
      });
      return {
        slots: [],
        note:
          `Para hoy ya no hay espacio: las citas se abren con mínimo ${minNotice} día(s) de anticipación, a partir del ${minLabel}. ` +
          'El rango que pediste queda antes de eso. Díselo al lead en positivo y con calidez —que para hoy ya no le puedes apartar espacio, pero a partir de ese día sí— y consulta de nuevo desde ese día para ofrecerle horarios concretos.',
      };
    }

    if (window.outOfHorizon && window.maxMs != null) {
      const maxLabel = label(new Date(window.maxMs).toISOString());
      await logBotEvent(tenant.clientId, turn.ghlConversationId, 'availability_checked', {
        serviceName,
        calendarId,
        from: new Date(window.fromMs).toISOString(),
        to: new Date(window.toMs).toISOString(),
        outcome: 'out_of_horizon',
        horizonDays: horizon,
      });
      return {
        slots: [],
        note:
          `Solo se pueden agendar horarios dentro de los próximos ${horizon} días (hasta ${maxLabel}). ` +
          'El rango que pediste queda fuera de esa ventana; dile al lead esa limitación y ofrécele un horario dentro de ella.',
      };
    }

    // Closed ≠ full. GHL answers both with an empty list, so a day the business never opens
    // used to come back as "sin disponibilidad" and reach the lead as "para el sábado ya no
    // tengo espacios" — a lie she acts on (she asks again next Saturday). The weekly schedule
    // is config we already render in the prompt, so the closed case is settled here, in code.
    // Day boundaries are the TENANT's: it is the business that opens, not the lead.
    const closed = closedRange(window.fromMs, window.toMs, config.timezone, config.hours);
    if (closed) {
      const closedNames = dayListEs(closed.closed);
      const openNames = openDaysEs(closed.open);
      await logBotEvent(tenant.clientId, turn.ghlConversationId, 'availability_checked', {
        serviceName,
        calendarId,
        from: new Date(window.fromMs).toISOString(),
        to: new Date(window.toMs).toISOString(),
        outcome: 'closed_day',
        closedDays: closed.closed,
        openDays: closed.open,
      });
      return {
        slots: [],
        note:
          `Ese rango cae SOLO en días que el negocio no abre (${closedNames}). No están llenos: esos días no hay atención. Se atiende ${openNames}. ` +
          `Díselo al lead con calidez y en positivo —que ${closedNames} no hay atención, pero ${openNames} sí— y ofrécele un día que sí se atienda. ` +
          `PROHIBIDO decirle que para ese día "ya no hay espacio", "está lleno" o "ya se agotaron": sería falso y va a volver a preguntar lo mismo. ` +
          'Consulta de nuevo un día que sí se atienda para ofrecerle horarios concretos.',
      };
    }

    const horizonNote =
      window.clamped && window.maxMs != null
        ? ` IMPORTANTE: el rango pedido excede la ventana de agendado. Solo hay cupo hasta ${label(new Date(window.maxMs).toISOString())} (próximos ${horizon} días). Si el lead pidió una fecha posterior, díselo explícitamente y ofrécele ÚNICAMENTE estos horarios.`
        : undefined;
    const noticeNote =
      window.liftedFrom && window.minMs != null
        ? ` IMPORTANTE: para hoy ya no hay espacio (las citas se abren con mínimo ${minNotice} día(s) de anticipación): estos horarios empiezan el ${label(new Date(window.minMs).toISOString())}. Si el lead pidió hoy, díselo en positivo y con calidez —para hoy ya no te queda espacio, pero sí le tienes estos— y ofrécele ÚNICAMENTE estos.`
        : '';
    // Only when the model ASKED for a start inside the floor: the default range (from = now)
    // is lifted by a couple of hours on every call, and saying so each time reads as "the
    // slots you have can't be paid for" and derails the booking (eval, 2026-09-22: 0/3).
    const payNote =
      window.liftedForPay && fromDate && payFloorMs != null && config.bookingPayment
        ? ` IMPORTANTE: los horarios más próximos ya no alcanzan a pagarse a tiempo (el apartado necesita al menos ${payableNoticeLabel(config.bookingPayment)} de anticipación): estos empiezan a partir del ${label(new Date(payFloorMs).toISOString())}. Si el lead pidió algo más pronto, díselo en positivo y ofrécele ÚNICAMENTE estos.`
        : '';

    const from = new Date(window.fromMs).toISOString();
    const to = new Date(window.toMs).toISOString();

    const ghl = new GhlClient(tenant.tenantId);
    try {
      const slots = await ghl.getAvailability(calendarId, from, to);
      const labeled = slots.map((s) => ({ ...s, label: label(s.start) }));
      // Persist the raw slots GHL returned so an availability claim can later be
      // audited against ground truth (the agent presents these labels verbatim).
      await logBotEvent(tenant.clientId, turn.ghlConversationId, 'availability_checked', {
        serviceName,
        calendarId,
        from,
        to,
        slotCount: labeled.length,
        slots: labeled.slice(0, 50).map((s) => ({ start: s.start, label: s.label })),
      });
      const baseNote =
        slots.length === 0
          ? 'Sin disponibilidad en el rango consultado.'
          : 'Ofrece estos horarios al lead usando EXACTAMENTE el texto del campo "label" (ya trae el día de la semana correcto). No recalcules ni traduzcas fechas.';
      return {
        slots: labeled,
        note: baseNote + (horizonNote ?? '') + noticeNote + payNote,
      };
    } catch (err) {
      await logBotEvent(tenant.clientId, turn.ghlConversationId, 'availability_checked', {
        serviceName,
        calendarId,
        from,
        to,
        outcome: 'error',
        error: err instanceof Error ? err.message : String(err),
      });
      return { slots: [], note: 'No se pudo consultar disponibilidad en este momento.' };
    }
  },
});
