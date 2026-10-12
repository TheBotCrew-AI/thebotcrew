/**
 * The stage outranks the angle (0068, live eval).
 *
 * Every live angle pool asks for commitment ("¿te aparto tu lugar?") because until
 * 0068 one pool served every lead. With the playbook, a NI lead — who only pressed
 * the ad's button and never answered — gets the SAME angle text but a stage section
 * that says: inform first, no appointment yet, cite only the configured facts. And a
 * C lead who already saw slots must not get them re-typed (they may be gone).
 *
 * Shown failing before trusted (REPEATS runs per side, gpt-5.6-luna, 2026-10-12):
 *   NI without the stage section: the nudge asked for the appointment in 3/3 runs
 *   and stated no treatment fact in 3/3. With it: 0/3 asked, 3/3 cited a fact.
 *   C without the section: slot times re-typed 0/3 (the noDatesRule already held);
 *   kept as a regression guard for the stage section stacking on that rule.
 *
 * Re-measure the "without" side with `STAGE_EVAL_CONTROL=1` (drops the stage section;
 * the NI cases are then EXPECTED to fail).
 *
 * Live-only (needs an API key); `pnpm eval`, excluded from the CI gate.
 */

import { describe, it, expect } from 'vitest';
import type { TenantContext } from '../../../core/types.js';
import { buildAgentRequestContext, type StageContext } from '../../../core/runtime-context.js';
import { evalApiKey, evalModel, evalProvider } from '../../front-desk/evals/eval-model.js';
import { parseAngleSelection } from '../angle-select.js';
import { buildReactivationAgent } from '../agent.js';

const REPEATS = 3;

const tenant: TenantContext = {
  tenantId: 't_eval',
  clientId: 'c_eval',
  ghlLocationId: 'loc_eval',
  enabledChannels: ['whatsapp'],
  config: {
    businessName: 'Dr. Heriberto Valdivia', timezone: 'America/Tijuana', tone: 'cálido, directo, sin presión',
    services: [], hours: {}, calendars: {}, faq: [], promptOverrides: {},
  },
} as unknown as TenantContext;

const turn = { ghlConversationId: 'conv_eval_stage', ghlContactId: 'contact_eval_stage', channel: 'whatsapp' as const };

/** Heriberto's live bótox angle: it asks for the appointment outright. */
const SLOT_ANGLE = 'Ángulo de lugar: pregunta en una línea si quiere que le aparten su lugar para su cita de bótox. Una sola pregunta, en neutro, que se conteste con una palabra.';

const BOTOX_FACTS = 'Por zona: frente $2,500, entrecejo $2,000, patas de gallo $2,000, maseteros $3,500. Full face (frente, entrecejo y patas de gallo): $6,000. Suaviza líneas de expresión y ayuda a prevenir la formación de nuevas arrugas.';

const NI_CTX: StageContext = {
  stage: 'NI',
  objective: 'Este lead sólo mandó el mensaje del anuncio y no ha conversado. Dale en UNA línea el dato que el anuncio prometía (qué incluye, precio o cómo funciona), tomado de "Lo que le interesa", y cierra con una pregunta cerrada facilísima sobre su caso. Todavía NO le pidas agendar.',
  service: { name: 'Botox', description: BOTOX_FACTS },
};

const C_CTX: StageContext = {
  stage: 'C',
  objective: 'Este lead ya pidió horarios o dijo que sí quiere. Tu único trabajo es cerrar: alude a los horarios que ya vio sin repetirlos y pregunta si le aparta uno o le busca otro. Nada de información nueva.',
  service: { name: 'Botox', description: BOTOX_FACTS },
};

const ASKS_FOR_APPOINTMENT = /agend|apart|cita\b|lugar/i;
const STATES_A_FACT = /\$|zona|frente|entrecejo|patas de gallo|maseteros|líneas de expresión/i;

const CONTROL = process.env.STAGE_EVAL_CONTROL === '1';

async function nudge(history: Array<{ role: 'user' | 'assistant'; content: string }>, stageContext?: StageContext): Promise<string> {
  if (CONTROL) stageContext = undefined;
  // The agent's message input type is a wide union the literal history satisfies at runtime.
  const res = await buildReactivationAgent().generate(history as unknown as Parameters<ReturnType<typeof buildReactivationAgent>['generate']>[0], {
    requestContext: buildAgentRequestContext({
      tenant, turn, provider: evalProvider, model: evalModel, llmApiKey: evalApiKey,
      reactivationCandidates: [SLOT_ANGLE],
      reactivationRound: { round: 0, isFinalTouch: false, reentryKeyword: 'CITA' },
      stageContext,
    }),
  });
  const message = parseAngleSelection(res.text, 1).message;
  console.log(`[stage-eval${CONTROL ? ' control' : ''}] ${stageContext?.stage ?? history.length} → ${message}`);
  return message;
}

const NI_HISTORY = [
  { role: 'user' as const, content: 'PRECIO' },
  { role: 'assistant' as const, content: '¡Hola! Con gusto. ¿Es tu primera vez con bótox o ya te lo has aplicado?' },
];

const C_HISTORY = [
  { role: 'user' as const, content: 'hola, quiero bótox en la frente' },
  { role: 'assistant' as const, content: 'Claro. La frente va en $2,500 y la aplica el doctor el mismo día de la valoración. Tengo el jueves a las 4:30 pm o el viernes a las 5:15 pm, ¿cuál te queda?' },
  { role: 'user' as const, content: 'déjame ver mi agenda' },
];

describe.skipIf(!evalApiKey)('reactivation nudge — the stage outranks the angle (0068)', () => {
  it.each(Array.from({ length: REPEATS }, (_, i) => i + 1))(
    'NI: a slot-asking angle becomes an informing nudge with a configured fact (run %i)',
    async () => {
      const message = await nudge(NI_HISTORY, NI_CTX);
      expect(message).not.toMatch(ASKS_FOR_APPOINTMENT);
      expect(message).toMatch(STATES_A_FACT);
      expect(message).toContain('?');
    },
  );

  it.each(Array.from({ length: REPEATS }, (_, i) => i + 1))(
    'C: the close alludes to the slots without re-typing them (run %i)',
    async () => {
      const message = await nudge(C_HISTORY, C_CTX);
      expect(message).not.toMatch(/4:30|5:15|jueves|viernes/i);
      expect(message).toContain('?');
    },
  );
});
