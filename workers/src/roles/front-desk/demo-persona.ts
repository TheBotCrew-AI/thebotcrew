/**
 * Demo-session persona builder: intake facts → the demo's prompt overrides.
 *
 * Deliberately a TEMPLATE, not an LLM call. The intake fields are already
 * structured (the agent extracted them conversationally), so a deterministic
 * builder gives us: zero extra latency/cost at the moment of highest drop-off
 * risk, no generation to go weird in front of a prospect, trivial testability,
 * and a much smaller prompt-injection surface — lead text is embedded as
 * length-capped DATA under labeled sections, never as instructions. Bump
 * PERSONA_VERSION when this template changes so cohorts stay comparable.
 */

import { z } from 'zod';
import type { PromptOverrides } from './config.js';

export const PERSONA_VERSION = 3;

/** Hard caps on lead-supplied text (injection blast-radius control). */
const CAPS = { name: 80, type: 80, service: 60, tone: 120, hours: 160, notes: 240 } as const;

export const demoIntakeSchema = z.object({
  businessName: z.string().min(1),
  businessType: z.string().min(1),
  services: z.array(z.string().min(1)).min(1).max(5),
  /** The person's own name if they gave it during intake — carried to the closer. */
  leadName: z.string().optional(),
  tone: z.string().optional(),
  hoursDescription: z.string().optional(),
  notes: z.string().optional(),
});

export type DemoIntake = z.infer<typeof demoIntakeSchema>;

/** Collapse whitespace/control chars and cap length. */
function clean(s: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, ' ').trim().slice(0, max);
}

export interface DemoPersona {
  /** Shape-compatible with demoPromptOverrides (overlaid at turn time). */
  overrides: PromptOverrides;
  /** What the lead told us, cleaned — stored on the session for the closer + reporting. */
  leadData: Record<string, unknown>;
}

export function buildDemoPersona(intake: DemoIntake): DemoPersona {
  const name = clean(intake.businessName, CAPS.name);
  const type = clean(intake.businessType, CAPS.type);
  const services = intake.services.map((s) => clean(s, CAPS.service)).filter(Boolean).slice(0, 5);
  const tone = intake.tone ? clean(intake.tone, CAPS.tone) : undefined;
  const hours = intake.hoursDescription ? clean(intake.hoursDescription, CAPS.hours) : undefined;
  const notes = intake.notes ? clean(intake.notes, CAPS.notes) : undefined;

  const identity =
    `Eres la recepcionista virtual de "${name}" (${type}). Atiendes a clientes por WhatsApp en español, ` +
    `como si fuera la operación real del negocio.`;

  const offering = [
    `# Servicios de ${name}`,
    ...services.map((s) => `- ${s}`),
    hours ? `\nHorario (según el dueño): ${hours}` : '',
    notes ? `\nNotas del dueño sobre el negocio: ${notes}` : '',
    `\nSi te piden un dato del negocio que no está aquí (p. ej. un precio exacto), resuélvelo en una frase natural — "ese dato te lo confirmamos al agendar" — y encamina la conversación hacia la cita. No insistas en lo que no sabes.`,
  ].filter(Boolean).join('\n');

  const qualificationNotes = `# Tu objetivo (demo)
1. Atiende como la recepcionista real de ${name}: saluda, entiende qué necesita el cliente y resuelve sus dudas con los datos de arriba.
2. Si el cliente quiere agendar, consulta horarios con getAvailability y agenda con bookAppointment como en una operación normal.
3. Conversa natural: mensajes cortos de chat, una cosa a la vez, sin interrogatorios y sin discursos largos. Si te preguntan varias cosas de golpe, contesta la más importante en corto y ofrece seguir con las demás.${tone ? `\n4. Tono pedido por el dueño: ${tone}` : ''}`;

  return {
    overrides: {
      identity,
      offering,
      qualificationNotes,
      toolInstructions: {
        getAvailability:
          'Ofrece MÁXIMO 3 horarios, en un solo mensaje corto y sin lista con viñetas ' +
          '(p. ej. "Tengo el viernes 10:00, viernes 4:00 o sábado 11:30 — ¿cuál te queda?"). ' +
          'Usa EXACTAMENTE el texto del campo "label" de cada horario que menciones; no recalcules fechas ni inventes horarios.',
      },
      confirmContactName: false,
      bookingEnabled: true,
    },
    leadData: {
      businessName: name,
      businessType: type,
      services,
      ...(intake.leadName?.trim() ? { leadName: clean(intake.leadName, CAPS.name) } : {}),
      ...(tone ? { tone } : {}),
      ...(hours ? { hoursDescription: hours } : {}),
      ...(notes ? { notes } : {}),
    },
  };
}
