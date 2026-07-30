/**
 * getAvailability — fetch real calendar slots for a service via GHL.
 * The agent must call this before offering or confirming any time.
 */

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { GhlClient } from '../../../ghl/client.js';
import { getActiveDemoSession, logBotEvent } from '../../../db/queries.js';
import { resolveAgentContext } from './agent-context.js';
import { resolveBookingWindow } from './booking-window.js';
import { simulatedSlots } from './demo-sim.js';

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
    const { tenant, turn, config } = resolveAgentContext(ctx);

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
        note: 'Ofrece estos horarios al lead usando EXACTAMENTE el texto del campo "label" (ya trae el día de la semana correcto). No recalcules ni traduzcas fechas.',
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

    // Format each slot's day/time in code (correct weekday in the tenant's tz), so
    // the agent presents them verbatim and never computes a date itself.
    const fmt = new Intl.DateTimeFormat('es-MX', {
      timeZone: config.timezone,
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
    const label = (iso: string): string => {
      try {
        return fmt.format(new Date(iso));
      } catch {
        return iso;
      }
    };

    // Deterministic booking horizon (business rule, per-tenant): the tool never looks
    // past now + bookingHorizonDays. Does NOT rely on the model behaving — the range is
    // clamped here, or (if it starts entirely beyond the horizon) we return that fact so
    // the agent redirects the lead to the valid window.
    const horizon = config.bookingHorizonDays ?? null;
    const window = resolveBookingWindow(Date.now(), fromDate, toDate, horizon);

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

    const horizonNote =
      window.clamped && window.maxMs != null
        ? ` IMPORTANTE: el rango pedido excede la ventana de agendado. Solo hay cupo hasta ${label(new Date(window.maxMs).toISOString())} (próximos ${horizon} días). Si el lead pidió una fecha posterior, díselo explícitamente y ofrécele ÚNICAMENTE estos horarios.`
        : undefined;

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
        note: horizonNote ? baseNote + horizonNote : baseNote,
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
