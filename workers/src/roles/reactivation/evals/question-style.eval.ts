/**
 * "¿sí o no?" — the label a lead reads as a demand (live eval).
 *
 * Incident, 2026-08-11: a nudge went out as *"¿quieres que te ayudemos a agendar
 * cita, si o no?"*. Nothing was broken — the model rendered its spec. The prompt
 * asked for a question "fácil de responder con una sola palabra o sí/no", and the
 * tenant angles read "Pregunta de sí o no". Both meant the SHAPE of the question.
 *
 * Why it's worth a live case and not just the unit test on the prompt text: the
 * failure is the model turning a spec into copy, so only generation can prove it
 * stopped. The angles below are the live ones (MADI + The Bot Crew), phrased the
 * way that produced it, because that's the pressure the rule has to hold under.
 *
 * Each case runs the generation REPEATS times: this class of rule is probabilistic
 * — a single green run has been misleading before (a model that obeys 4 times out
 * of 5 still writes it to 20% of silent leads).
 *
 * Live-only (needs an API key); `pnpm eval`, excluded from the CI gate.
 */

import { describe, it, expect } from 'vitest';
import type { TenantContext } from '../../../core/types.js';
import { buildAgentRequestContext } from '../../../core/runtime-context.js';
// Shared with the front-desk suite on purpose: which model the live cases run
// against is a platform choice, not a per-role one.
import { evalApiKey, evalModel, evalProvider } from '../../front-desk/evals/eval-model.js';
import { parseAngleSelection } from '../angle-select.js';
import { buildReactivationAgent } from '../agent.js';

const REPEATS = 3;

/** Reactivation reads only businessName + tone from config; the rest is inert here. */
const tenant = (businessName: string, tone: string): TenantContext =>
  ({
    tenantId: 't_eval',
    clientId: 'c_eval',
    ghlLocationId: 'loc_eval',
    enabledChannels: ['whatsapp'],
    config: { businessName, timezone: 'America/Tijuana', tone, services: [], hours: {}, calendars: {}, faq: [], promptOverrides: {} },
  } as unknown as TenantContext);

const turn = { ghlConversationId: 'conv_eval_question_style', ghlContactId: 'contact_eval_question_style', channel: 'whatsapp' as const };

/**
 * The label, however it gets typed: with or without the accent, with a slash, and
 * with or without the question mark GHL leads actually see. Deliberately does NOT
 * match a legitimate "¿sí?" or a sentence that merely contains "no".
 */
const YES_NO_LABEL = /(s[ií]\s*[o/]\s*no|no\s*[o/]\s*s[ií])\s*[?¿.!]?/i;

async function nudge(t: TenantContext, candidates: string[]): Promise<string> {
  const res = await buildReactivationAgent().generate(
    [{ role: 'user', content: 'Genera el mensaje de seguimiento.' }],
    {
      requestContext: buildAgentRequestContext({
        tenant: t,
        turn,
        provider: evalProvider,
        model: evalModel,
        llmApiKey: evalApiKey,
        reactivationCandidates: candidates,
      }),
    },
  );
  // Parse exactly like the runner does — the ANGULO tag never reaches the lead.
  return parseAngleSelection(res.text, candidates.length).message;
}

describe.skipIf(!evalApiKey)('reactivation nudge — never writes the "sí o no" label', () => {
  it.each(Array.from({ length: REPEATS }, (_, i) => i + 1))(
    'MADI angle that literally says "Pregunta de sí o no" (run %i)',
    async () => {
      const message = await nudge(tenant('MADI Skin Care', 'cálida, cercana y segura'), [
        'Retoma con ligereza: pregunta si quiere que le aparten un espacio para su sesión. Pregunta de sí o no, en trato neutro (nunca asumas género).',
        'Ángulo de cierre suave: pregunta si quiere que le manden la info de los tratamientos que le interesan para que la vea con calma. Pregunta de sí o no.',
      ]);

      expect(message).not.toMatch(YES_NO_LABEL);
      // It still has to bait a reply — a nudge with no question is a different bug.
      expect(message).toContain('?');
    },
  );

  it.each(Array.from({ length: REPEATS }, (_, i) => i + 1))(
    'Bot Crew angle phrased "una pregunta simple de sí o no" (run %i)',
    async () => {
      const message = await nudge(tenant('The Bot Crew', 'directo, cálido, sin presión'), [
        'Ángulo binario de baja fricción: haz una pregunta simple de sí o no, ofreciendo mostrarle cómo quedaría el agente en su negocio. Una sola pregunta.',
      ]);

      expect(message).not.toMatch(YES_NO_LABEL);
      expect(message).toContain('?');
    },
  );
});

/**
 * The incident's exact shape: a LATE round (its "no por ahora" out is round 1+ wording)
 * on `gpt-5.6-luna`, 2026-08-12 03:15 — "Hola, quizá no sea buen momento; si prefieres,
 * responde 'no por ahora' y dejamos de escribirte. ¿Quieres que te ayudemos a apartar tu
 * sesión, sí o no?". Repeated, because that round stacks a second softening instruction
 * on top of the angle and is where the wording actually broke.
 */
describe.skipIf(!evalApiKey)('late round — softer tone, same ban', () => {
  it.each(Array.from({ length: REPEATS }, (_, i) => i + 1))('soft retry round asks without the label (run %i)', async () => {
    const res = await buildReactivationAgent().generate(
      [{ role: 'user', content: 'Genera el mensaje de seguimiento.' }],
      {
        requestContext: buildAgentRequestContext({
          tenant: tenant('MADI Skin Care', 'cálida, cercana y segura'),
          turn,
          provider: evalProvider,
          model: evalModel,
          llmApiKey: evalApiKey,
          reactivationCandidates: ['Ángulo de empatía: pregunta con ligereza si es buen momento para retomar. Pregunta de sí o no.'],
          reactivationRound: { round: 1, isFinalTouch: false, reentryKeyword: 'CITA' },
        }),
      },
    );

    expect(parseAngleSelection(res.text, 1).message).not.toMatch(YES_NO_LABEL);
  });
});
