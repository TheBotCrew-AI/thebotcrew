/**
 * Courtesy gate — golden cases for "the bot says goodbye once" (0071).
 *
 * Two failure modes, opposite costs: answering a 👍 to the bot's own goodbye is the loop
 * Leo reported; staying silent on a "gracias" to a booking confirmation (or worse, on
 * something real) is a lead who feels ignored. Every case below is first checked to be a
 * `courtesyCandidate` — a case the free filter already answers tests nothing here.
 * Threads are from prod (Heriberto, 2026-10-13), names kept, ids dropped.
 *
 * Measured 2026-10-13: gpt-6-luna 3 runs, 30/30; gpt-5.6-luna (HappyNatyNat's pin) 3 runs,
 * 30/30. Ablation: with rule 1 ("the bot's last message WAS ALREADY a goodbye") and the
 * "confirmed a booking / gave information → false" line replaced by "the lead only
 * thanks or reacts" → 11 of 12 reply cases red over 3 runs on gpt-6-luna (the thank-you to
 * the booking confirmation, the moved appointment and the address every time). That rule
 * is what makes it "goodbye ONCE" rather than "never answer a thank-you".
 *
 * Live-only (needs an API key); `pnpm eval`, excluded from the CI gate.
 */

import { describe, it, expect, vi } from 'vitest';
import type { ConversationMessage } from '../core/types.js';

vi.mock('../db/queries.js');

import type { AuxLlmCall } from './aux-llm.js';
import { classifyCourtesySkip, courtesyCandidate } from './courtesy-gate.js';
import { evalApiKey, evalModel, evalProvider } from '../roles/front-desk/evals/eval-model.js';

const llm: AuxLlmCall = {
  clientId: 'client_eval',
  ghlConversationId: 'conv_eval_courtesy_gate',
  provider: evalProvider,
  apiKey: evalApiKey,
  model: evalModel,
  keySource: 'platform',
};

const m = (senderType: ConversationMessage['senderType'], content: string): ConversationMessage => ({
  direction: senderType === 'lead' ? 'inbound' : 'outbound',
  senderType,
  content,
  sentAt: '2026-10-13T00:00:00Z',
});

const BOOKED_WA = [
  m('bot', 'Para tu evaluación sin costo, tengo miércoles, 14 de octubre, 3:45 p.m. o miércoles, 14 de octubre, 5:45 p.m.; ¿cuál te acomoda?'),
  m('lead', 'A las 3:45 está bien'),
  m('bot', '¡Claro! Te agendo para el miércoles, 14 de octubre, a las 3:45 p.m. ¿A nombre de quién va la cita?'),
  m('lead', 'Perla Hernández'),
  m('bot', '¡Listo, Perla! Tu cita quedó para el miércoles, 14 de octubre, 3:45 p.m. Te llegará la confirmación y los recordatorios por WhatsApp.'),
];

const MOVED_FB = [
  m('lead', 'Buenos días disculpe para la siguiente semana no tiene disponible al parecer esta semana me va ser imposible ir'),
  m('bot', 'Para el lunes, 19 de octubre, tengo 3:45 p.m. o 5:45 p.m.; ¿cuál te acomoda?'),
  m('lead', 'Ok lunes 5:45pm'),
  m('bot', 'Listo, Perla. Tu cita quedó para el lunes, 19 de octubre, 5:45 p.m. Cualquier cosa me escribes 🙂'),
];

/** The bot already said goodbye; the lead only thanks/reacts → silence. */
const SKIP: Array<{ name: string; tail: ConversationMessage[] }> = [
  {
    name: '🙏 after the bot returned the "lindo y bendecido día"',
    tail: [...MOVED_FB, m('lead', 'Gracias lindo y bendecido día 🙂'), m('bot', 'Igualmente, Perla 🙂 Que tengas un lindo y bendecido día.'), m('lead', '🙏')],
  },
  {
    name: '"Gracias" after "te esperamos" (the CONFIRMO already got its reply)',
    tail: [...BOOKED_WA, m('lead', 'CONFIRMO'), m('bot', '¡Gracias, Perla! Te esperamos el miércoles, 14 de octubre, a las 3:45 p.m. nos vemos pronto.'), m('lead', 'Gracias')],
  },
  {
    name: '👍 after "aquí andamos para ayudarte"',
    tail: [
      m('lead', 'Ah no, yo estoy en Durango'),
      m('bot', 'Ay, sí te entiendo 😕 El consultorio está en Chihuahua y la evaluación tendría que ser en persona.'),
      m('lead', 'Ok gracias'),
      m('bot', '¡Gracias a ti! Cuando tengas vuelta a Chihuahua, aquí andamos para ayudarte.'),
      m('lead', '👍'),
    ],
  },
  {
    name: '"Igualmente bendiciones" + ❤️ burst after the goodbye',
    tail: [...BOOKED_WA, m('lead', 'Muchas gracias'), m('bot', '¡Con mucho gusto, Perla! Te esperamos el miércoles 🙂'), m('lead', 'Igualmente bendiciones'), m('lead', '❤️')],
  },
];

/** The bot has not said goodbye yet, or the lead brings something new → reply. */
const REPLY: Array<{ name: string; tail: ConversationMessage[] }> = [
  { name: '"Gracias" to the booking confirmation', tail: [...BOOKED_WA, m('lead', 'Gracias')] },
  { name: '"CONFIRMO" to the booking (Perla, 2026-10-13)', tail: [...BOOKED_WA, m('lead', 'CONFIRMO')] },
  { name: '"Ok lunes 5:45pm" thread: "Gracias 🙂" to the moved appointment', tail: [...MOVED_FB, m('lead', 'Gracias 🙂')] },
  {
    name: '"Ok gracias" to the address',
    tail: [
      m('lead', 'En donde se ubican?'),
      m('bot', 'Estamos en Periférico de la Juventud 6902, Plaza Cumbres, Local 34, Chihuahua, Chih., C.P. 31217; justo enfrente de la tienda de AT&T.'),
      m('lead', 'Ok gracias'),
    ],
  },
  {
    name: 'after the goodbye, something new without a question mark',
    tail: [...BOOKED_WA, m('lead', 'Gracias'), m('bot', '¡Con mucho gusto, Perla! Te esperamos 🙂'), m('lead', 'oye y mi hermana tambien quiere ir')],
  },
  {
    name: 'after the goodbye, a change of plans',
    tail: [...BOOKED_WA, m('lead', 'Gracias'), m('bot', '¡Con mucho gusto, Perla! Te esperamos 🙂'), m('lead', 'Siempre no voy a poder ir el miercoles')],
  },
];

describe.skipIf(!evalApiKey)(`courtesy gate — live (${evalModel})`, () => {
  for (const c of SKIP) {
    it(`silence: ${c.name}`, { timeout: 60_000 }, async () => {
      expect(courtesyCandidate(c.tail), 'not a candidate — the filter already answers this case').not.toBeNull();
      expect(await classifyCourtesySkip(c.tail, llm)).toBe(true);
    });
  }
  for (const c of REPLY) {
    it(`reply: ${c.name}`, { timeout: 60_000 }, async () => {
      expect(courtesyCandidate(c.tail), 'not a candidate — the filter already answers this case').not.toBeNull();
      expect(await classifyCourtesySkip(c.tail, llm)).toBe(false);
    });
  }
});
