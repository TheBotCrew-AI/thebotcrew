/**
 * "(sí/no)" — the label the front-desk was appending to its own questions (live eval).
 *
 * Found while chasing the reactivation nudge Leo flagged 2026-08-11: the front-desk
 * had been doing the same thing longer and more often. Six messages between
 * 2026-08-01 and 2026-08-10 closed with a literal "(sí/no)":
 *
 *   "¿Confirmo que te refieres a axilas + medias piernas (paquete de 6 sesiones)? (sí/no)"
 *   "Perfecto — ahorita te paso el costo; ... ¿se te irrita o te salen bolitas...? (sí/no)"
 *
 * The source was the tenant's own flow, which asked for questions that are
 * "cerradas (sí/no o de 2–3 opciones)" — a description of the SHAPE that the model
 * rendered as copy. So the pressure line below is reproduced verbatim from what MADI
 * ran: the base rule has to outrank a tenant's wording, because that wording is a
 * client's to write and it will be written this way again.
 *
 * Live-only (needs an API key); `pnpm eval`, excluded from the CI gate.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../db/queries.js');
vi.mock('../../../ghl/client.js', () => ({
  GhlClient: vi.fn(() => ({ addContactTags: vi.fn().mockResolvedValue(undefined) })),
}));

import { buildFrontDeskAgent } from '../agent.js';
import { buildAgentRequestContext } from '../../../core/runtime-context.js';
import type { TenantContext, TurnContext } from '../../../core/types.js';
import { madiTenant } from './fixtures.js';
import { evalApiKey, evalModel, evalProvider } from './eval-model.js';

/**
 * Repeats per case: the rule is probabilistic, so one green run proves nothing —
 * the reproduction above fired once in three. Cheap on the default model (~3s a
 * generation); slow but affordable on `EVAL_MODEL=gpt-5-mini`.
 */
const REPEATS = 4;

/** The line MADI's flow actually carried, quoted so the case tests real pressure. */
const CLOSED_QUESTION_PRESSURE =
  '\nLa apertura ("¿Cómo te puedo apoyar hoy?") es la ÚNICA pregunta abierta. De la SEGUNDA pregunta ' +
  'en adelante, TODAS son cerradas (sí/no o de 2–3 opciones) para que responder sea de un toque.';

/** madiTenant, plus the tenant-authored instruction that produced the label. */
// `promptOverrides` is raw jsonb (typed `unknown`; the role parses it at runtime),
// so it gets narrowed here to be extended in place.
const madiOverrides = madiTenant.config.promptOverrides as Record<string, unknown>;
const pressuredTenant: TenantContext = {
  ...madiTenant,
  config: {
    ...madiTenant.config,
    promptOverrides: {
      ...madiOverrides,
      qualificationNotes: String(madiOverrides.qualificationNotes ?? '') + CLOSED_QUESTION_PRESSURE,
    },
  },
};

const turn: TurnContext = {
  ghlConversationId: 'conv_eval_question_style',
  ghlContactId: 'contact_eval_question_style',
  channel: 'whatsapp',
};

const rc = () =>
  buildAgentRequestContext({
    tenant: pressuredTenant,
    turn,
    provider: evalProvider,
    model: evalModel,
    llmApiKey: evalApiKey,
  });

/** With or without accent, slash or "o", parenthesized or not — all of it is the label. */
const YES_NO_LABEL = /\(?\s*s[ií]\s*[o/]\s*no\s*\)?\s*[?¿.!]?/i;

/**
 * The turn that reproduces it. Confirming what a photo shows is where the model
 * reaches for the label — prod, 2026-08-02: "¿Es la foto de la zona que quieres
 * depilar? (sí/no)". With the rule removed this fired on run 3 of 3 as
 * "¿Esa foto es de la zona que quieres tratar, sí o no?", which is why it's the
 * primary case and why it repeats: the miss rate is well under 100%.
 *
 * `[imagen]` is the literal placeholder the webhook writes for an image inbound
 * (`placeholderFor`, 0046), so this is the exact text the agent sees in history.
 */
const PHOTO_TURN = [
  { role: 'user' as const, content: 'Hola, me interesa el láser' },
  { role: 'assistant' as const, content: '¡Hola! Soy Majo, de MADI Skin Care 😊 ¿Qué zona te gustaría tratar?' },
  { role: 'user' as const, content: '[imagen]' },
];

/** Broader coverage: the ambiguity check that produced the "(sí/no)" messages. */
const CONFIRM_TURN = [
  { role: 'user' as const, content: 'Hola' },
  { role: 'assistant' as const, content: '¡Hola! Soy Majo, de MADI Skin Care 😊 ¿Cómo te puedo apoyar hoy?' },
  { role: 'user' as const, content: 'quiero depilarme las axilas y las piernas, cuanto es' },
];

beforeEach(() => vi.clearAllMocks());

describe.skipIf(!evalApiKey)('front-desk — closed questions without the label', () => {
  it.each(Array.from({ length: REPEATS }, (_, i) => i + 1))(
    'confirming what a photo shows carries no label (run %i)',
    async () => {
      const res = await buildFrontDeskAgent().generate(PHOTO_TURN, { requestContext: rc() });

      expect(res.text).not.toMatch(YES_NO_LABEL);
      // The question itself must survive the ban — closed is still the goal.
      expect(res.text).toContain('?');
    },
  );

  it.each(Array.from({ length: REPEATS }, (_, i) => i + 1))(
    'an ambiguity check carries no "(sí/no)" (run %i)',
    async () => {
      const res = await buildFrontDeskAgent().generate(CONFIRM_TURN, { requestContext: rc() });

      expect(res.text).not.toMatch(YES_NO_LABEL);
      expect(res.text).toContain('?');
    },
  );

  it('a direct yes/no question from the lead is answered without echoing the label', async () => {
    const res = await buildFrontDeskAgent().generate(
      [
        { role: 'user', content: 'Hola' },
        { role: 'assistant', content: '¡Hola! Soy Majo, de MADI Skin Care 😊 ¿Cómo te puedo apoyar hoy?' },
        { role: 'user', content: '¿el láser sirve para vello güero, sí o no?' },
      ],
      { requestContext: rc() },
    );

    expect(res.text).not.toMatch(YES_NO_LABEL);
  });
});
