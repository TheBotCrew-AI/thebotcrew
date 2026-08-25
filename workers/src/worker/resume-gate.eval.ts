/**
 * Resume gate — golden cases for the "does this still need a reply?" classifier (0053).
 *
 * A turn that wakes up after the human pause must stay quiet when the lead's last
 * message is a courtesy close ("Gracias") after the team resolved things, and must
 * still answer a real question nobody got to. Two failure modes, opposite costs:
 * a needless "¡Con gusto!" is a small annoyance; a real question left unanswered is a
 * lost lead. The prompt is biased to reply when unsure, so the close cases are the
 * ones doing the work here.
 *
 * Measured 2026-08-25. gpt-5.6-luna: 3 runs, 24/24 verdicts. gpt-5-mini: 2 runs, 16/16.
 * Ablations, to know what these cases actually defend: with the `needs_reply = false`
 * rule deleted → still 24/24 (3 runs); with ALL three rule lines deleted (only the
 * framing question + JSON contract left) → still 16/16 (2 runs). So the rule lines are
 * belt-and-suspenders, not load-bearing — both models get this from the framing alone.
 * What the suite guards is the framing itself, the output contract (a boolean
 * `needs_reply`, parsed by `parseNeedsReply`), and a future model swap; the only
 * baseline that turns the close cases red is having no classifier at all.
 *
 * Live-only (needs an API key); `pnpm eval`, excluded from the CI gate.
 */

import { describe, it, expect, vi } from 'vitest';
import type { ConversationMessage } from '../core/types.js';

vi.mock('../db/queries.js');

import type { AuxLlmCall } from './aux-llm.js';
import { classifyNeedsReply } from './resume-gate.js';
import { evalApiKey, evalModel, evalProvider } from '../roles/front-desk/evals/eval-model.js';

const llm: AuxLlmCall = {
  clientId: 'client_eval',
  ghlConversationId: 'conv_eval_resume_gate',
  provider: evalProvider,
  apiKey: evalApiKey,
  model: evalModel,
  keySource: 'platform',
};

const m = (senderType: ConversationMessage['senderType'], content: string): ConversationMessage => ({
  direction: senderType === 'lead' ? 'inbound' : 'outbound',
  senderType,
  content,
  sentAt: '2026-08-25T00:00:00Z',
});

const OPENING = [
  m('lead', 'Hola, me interesa la depilación láser de axilas'),
  m('bot', '¡Hola! Claro, el paquete de 6 sesiones de axilas es de $2,300. ¿Te gustaría dejar solicitada tu primera sesión?'),
];

/** Last message is a courtesy close after the TEAM resolved it → no reply. */
const NO_REPLY: Array<{ name: string; tail: ConversationMessage[] }> = [
  {
    name: '"Gracias" after the team answered the price',
    tail: [...OPENING, m('lead', '¿Y por sesión suelta?'), m('human_agent', 'Por sesión son $500'), m('lead', 'Gracias')],
  },
  {
    name: '"Ok perfecto, ahí nos vemos" after the team confirmed the appointment',
    tail: [...OPENING, m('lead', '¿Tienen el jueves a las 4?'), m('human_agent', 'Sí, te dejo la cita el jueves a las 4 pm'), m('lead', 'Ok perfecto, ahí nos vemos')],
  },
  {
    name: 'a lone thumbs-up',
    tail: [...OPENING, m('lead', '¿Dónde están?'), m('human_agent', 'Plaza Financiera, Blvd. Sánchez Taboada 10110'), m('lead', '👍')],
  },
  {
    name: '"Va, gracias" after the team resolved the payment question',
    tail: [...OPENING, m('lead', '¿Se paga todo desde la primera sesión?'), m('human_agent', 'Sí, los paquetes se pagan en la primera sesión porque son precio de promoción'), m('lead', 'Va, gracias')],
  },
];

/** Something is still pending → reply. */
const REPLY: Array<{ name: string; tail: ConversationMessage[] }> = [
  {
    name: 'a follow-up price question nobody answered',
    tail: [...OPENING, m('lead', '¿Y por sesión suelta?'), m('human_agent', 'Por sesión son $500'), m('lead', '¿Y el de bikini cuánto sale?')],
  },
  {
    name: 'the lead proposes a time and nobody answered',
    tail: [...OPENING, m('lead', 'Sí me interesa'), m('human_agent', '¿Qué día te acomoda?'), m('lead', '¿Puede ser el jueves a las 4?')],
  },
  {
    name: 'a location question left hanging',
    tail: [...OPENING, m('lead', '¿Dónde están ubicados?')],
  },
  {
    name: 'courtesy PLUS a new question — the question wins',
    tail: [...OPENING, m('lead', '¿Se paga todo desde la primera?'), m('human_agent', 'Sí, en la primera sesión'), m('lead', 'Gracias. Y una duda, ¿duele?')],
  },
];

describe.skipIf(!evalApiKey)('resume gate — needs_reply classifier (live)', () => {
  for (const c of NO_REPLY) {
    it(`stays quiet: ${c.name}`, async () => {
      expect(await classifyNeedsReply(c.tail, llm)).toBe(false);
    });
  }
  for (const c of REPLY) {
    it(`replies: ${c.name}`, async () => {
      expect(await classifyNeedsReply(c.tail, llm)).toBe(true);
    });
  }
});
