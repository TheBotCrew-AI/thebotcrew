/**
 * getAvailability — fetch real calendar slots for a service via GHL.
 * The agent must call this before offering or confirming any time.
 */

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { GhlClient } from '../../../ghl/client.js';
import { resolveAgentContext } from './agent-context.js';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

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
    const { tenant, config } = resolveAgentContext(ctx);
    const calendarId = config.calendars[serviceName];
    if (!calendarId) {
      return {
        slots: [],
        note: `No hay un calendario configurado para "${serviceName}".`,
      };
    }

    const from = fromDate ?? new Date().toISOString();
    const to = toDate ?? new Date(Date.now() + SEVEN_DAYS_MS).toISOString();

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

    const ghl = new GhlClient(tenant.tenantId);
    try {
      const slots = await ghl.getAvailability(calendarId, from, to);
      return {
        slots: slots.map((s) => ({ ...s, label: label(s.start) })),
        note:
          slots.length === 0
            ? 'Sin disponibilidad en el rango consultado.'
            : 'Ofrece estos horarios al lead usando EXACTAMENTE el texto del campo "label" (ya trae el día de la semana correcto). No recalcules ni traduzcas fechas.',
      };
    } catch {
      return { slots: [], note: 'No se pudo consultar disponibilidad en este momento.' };
    }
  },
});
