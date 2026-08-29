/**
 * setLeadTimezone — the lead said where they are; make every later time label
 * read in THEIR clock.
 *
 * The place → zone step is a lookup in code (core/lead-timezone.ts), never the
 * model's own conversion: the model passes the words the lead used, and either a
 * zone comes back or the tool says it didn't recognise the place. Persisted with
 * source 'lead', which the RPC lets override the phone-area-code guess and never
 * be overridden by it again (0057). Only meaningful for tenants with
 * `lead_timezone_enabled`; the tool is a no-op elsewhere so the prompt can offer
 * it unconditionally.
 */

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { setLeadTimezone } from '../../../db/queries.js';
import { GhlClient } from '../../../ghl/client.js';
import { syncContactTimezone } from '../../../ghl/contact-timezone.js';
import { timezoneFromPlace, zoneLabel } from '../../../core/lead-timezone.js';
import { resolveAgentContext } from './agent-context.js';

export const setLeadTimezoneTool = createTool({
  id: 'setLeadTimezone',
  description:
    'Registra en qué ciudad o estado está el lead, para que los horarios se le muestren en SU hora. ' +
    'Llámala cuando el lead diga dónde está (ej. "estoy en Monterrey", "somos de Cancún") — ANTES de ' +
    'ofrecerle horarios. Pásale el lugar tal como lo dijo; la conversión la hace el sistema, no tú.',
  inputSchema: z.object({
    place: z
      .string()
      .min(1)
      .describe('La ciudad o el estado que mencionó el lead, tal cual (ej. "Monterrey", "Quintana Roo", "CDMX").'),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    timezone: z.string().optional(),
    message: z.string(),
  }),
  execute: async ({ place }, ctx) => {
    const { config, tenant, turn } = resolveAgentContext(ctx);

    // A walk-in tenant renders the calendar's clock no matter where the number is from;
    // the demo is a roleplayed walk-in clinic. Both: acknowledge and change nothing.
    if (!config.leadTimezoneEnabled || turn.activeRole === 'demo') {
      return { ok: true, message: 'Anotado. Los horarios se manejan en la hora del negocio.' };
    }

    const tz = timezoneFromPlace(place);
    if (!tz) {
      // A neighbourhood or a small town we don't map. With a zone already on file (the
      // phone guess) the flow must not stall on it — keep that zone and move on; only with
      // nothing on file is the state worth a question.
      if (turn.leadTimezone) {
        return {
          ok: false,
          timezone: turn.leadTimezone,
          message:
            `No reconocí "${place}" como ciudad o estado; se conserva la zona actual (hora de ${zoneLabel(turn.leadTimezone)}). ` +
            'Sigue con normalidad. Si el lead menciona el estado, vuelve a llamar esta herramienta.',
        };
      }
      return {
        ok: false,
        message: `No reconocí "${place}" como una ciudad o estado. Pregúntale al lead en qué estado está y vuelve a llamar esta herramienta.`,
      };
    }

    // Same object the other tools read through the request context: a getAvailability
    // later in THIS turn already labels in the corrected zone, not on the next message.
    turn.leadTimezone = tz;
    try {
      await setLeadTimezone(turn.ghlConversationId, tz, 'lead');
    } catch (err) {
      // The turn keeps the zone in memory; only persistence failed. Logged, not surfaced.
      console.error('[setLeadTimezone] persist failed (non-blocking):', err instanceof Error ? err.message : String(err));
    }
    // GHL's own confirmation/reminder workflows render in the contact's Timezone field.
    await syncContactTimezone(new GhlClient(tenant.tenantId), turn.ghlContactId, tz, 'setLeadTimezone');

    return {
      ok: true,
      timezone: tz,
      message:
        `Listo: el lead está en hora de ${zoneLabel(tz)}. Si ya le habías ofrecido horarios, vuelve a consultar ` +
        'getAvailability: los labels ya vendrán en su hora. Preséntalos EXACTAMENTE como vengan.',
    };
  },
});
