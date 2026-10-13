/**
 * Dr. Heriberto Valdivia — láser CO₂, anuncio de presentación P5 "Tapar no es tratar" (`lp5`).
 * La lead contesta la pregunta del ángulo (qué tipo de cicatriz) y ese MISMO turno trae la
 * evaluación en media línea y DOS horarios reales — nunca una pregunta más de calificación (la
 * zona) ni una de permiso ("¿te gustaría agendarla?"). Historias tomadas de los hilos de octubre
 * que murieron ahí: d6716c4c ("Hundidas" → "¿en qué zona?") y 2730f707 ("Las dos" → zona →
 * "¿te gustaría agendarla?").
 *
 * `HLP_RED=1` corre los mismos mensajes con el texto anterior de lp5 (`OLD_TEXT`): el lado rojo.
 *
 * MEDIDO 2026-10-12 (gpt-5.6-luna): con el texto vivo 10/10 (5 corridas × 2 casos: getAvailability +
 * label real + sin pregunta de permiso) · con el texto anterior en el fixture 0/10 — las 10 preguntan
 * la zona ("¿mejillas, frente o barbilla?"), el patrón de los hilos · con `HLP_RED=1` 1/6.
 *
 * Live cases need an API key (`pnpm eval`); excluded from the CI gate.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../db/queries.js');

const getAvailability = vi.fn();
vi.mock('../../../ghl/client.js', () => ({
  GhlClient: vi.fn(() => ({
    getAvailability,
    getContactAppointments: vi.fn().mockResolvedValue([]),
    addContactTags: vi.fn().mockResolvedValue(undefined),
  })),
}));

import * as q from '../../../db/queries.js';
import { buildFrontDeskAgent } from '../agent.js';
import { slotLabel } from '../tools/slot-label.js';
import { buildAgentRequestContext } from '../../../core/runtime-context.js';
import type { TenantContext, TurnContext } from '../../../core/types.js';
import { HERIBERTO_LASER_PRESENTACION, heribertoTenant } from './fixtures.js';
import { evalApiKey, evalModel, evalProvider } from './eval-model.js';

const TZ = 'America/Chihuahua';
const RED = process.env.HLP_RED === '1';

/** [texto vivo, texto anterior] — el lado rojo restaura cada par; si uno no aparece, lanza. */
const OLD_TEXT: Array<[string, string]> = [
  [
    `- Antes de ofrecer la evaluación, entiende su caso con UNA sola pregunta: la de tu "Ángulo de entrada". No le preguntes nada más sobre su caso (ni la zona, ni desde cuándo, ni qué ha probado), salvo que ella lo saque.
- En cuanto conteste esa pregunta, ese MISMO mensaje explica en media línea el primer paso —una evaluación médica con el Dr. Valdivia para saber qué tiene su piel y qué sí le va a funcionar— y cierra con DOS horarios concretos para esa evaluación (llama getAvailability en ese turno). La pregunta es cuál de los dos le acomoda. Nunca cierres preguntando si quiere agendar, si le apartas un espacio o si le compartes horarios: una pregunta de permiso deja la conversación muerta; dos horarios la convierten en una decisión.`,
    `- Antes de ofrecer la evaluación, entiende su caso con una o dos preguntas como máximo: qué zona, desde cuándo, qué ha probado. Una por mensaje, y no preguntes lo que ya te contó.
- Luego explica el primer paso: una evaluación médica con el Dr. Valdivia para saber qué tiene su piel y qué sí le va a funcionar.`,
  ],
  [
    `- Cuando te conteste, pasa directo a la evaluación con sus dos horarios: ahí el doctor ve el tipo de cicatriz y le dice cuánto puede mejorar.`,
    `- Después, si hace falta, UNA pregunta más (en qué zona o qué ha probado) y pasa a la evaluación: ahí el doctor ve el tipo de cicatriz y le dice cuánto puede mejorar.`,
  ],
  [
    `- Después: en cuanto sepas qué le interesa y no le quede una duda encima, o en cuanto pida agendar o diga que sí quiere ir. Ahí no la califiques más: llama getAvailability y ofrécele DOS horarios concretos. La pregunta es cuál de los dos, no "¿cuándo puedes?" ni "¿te gustaría agendar?": ofrecer la consulta es darle los horarios, nunca pedirle permiso para dárselos.`,
    `- Después: cuando ya entendiste qué busca y no le quedan dudas encima — normalmente tras dos o tres intercambios — o en cuanto pida agendar o diga que sí quiere ir. Ahí no la califiques más: llama getAvailability y ofrécele DOS horarios concretos. La pregunta es cuál de los dos, no "¿cuándo puedes?".`,
  ],
];

const lp5 = (): typeof HERIBERTO_LASER_PRESENTACION.lp5 => {
  const v = HERIBERTO_LASER_PRESENTACION.lp5;
  if (!RED) return v;
  let notes = v.qualificationNotes;
  for (const [now, before] of OLD_TEXT) {
    if (!notes.includes(now)) throw new Error(`HLP_RED anchor not found: ${now.slice(0, 50)}`);
    notes = notes.split(now).join(before);
  }
  return { ...v, qualificationNotes: notes };
};

const tenant: TenantContext = {
  ...heribertoTenant,
  config: { ...heribertoTenant.config, promptVariants: { lp5: lp5() } },
};

const turn: TurnContext = {
  ghlConversationId: 'conv_eval_lp5',
  ghlContactId: 'contact_eval_lp5',
  contactPhone: '+526141234567',
  channel: 'whatsapp',
  promptVariant: 'lp5',
};

const nextWeekday = (): string => {
  const d = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
  while ([0, 6].includes(d.getUTCDay())) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};
const DAY = nextWeekday();
const SLOTS = [`${DAY}T16:15:00-06:00`, `${DAY}T18:15:00-06:00`].map((start) => ({ start, end: start }));
const LABELS = SLOTS.map((s) => slotLabel(s.start, TZ, TZ));

/** Does the reply name a weekday AND a time that belong to the SAME real slot? */
const usesRealLabel = (text: string): boolean =>
  LABELS.some((label) => {
    const weekday = label.split(',')[0]!.toLowerCase();
    const time = label.match(/\d{1,2}:\d{2}/)?.[0] ?? '';
    return !!time && text.includes(weekday) && text.includes(time);
  });

type ToolCallChunkLike = { payload: { toolName: string } };
const toolIds = (res: { toolCalls?: ToolCallChunkLike[] }): string[] => (res.toolCalls ?? []).map((c) => c.payload.toolName);

const PRELOADED = 'Hola, tengo cicatrices de acné y quiero saber cuánto pueden mejorar';
const ANGLE_OPENER =
  '¡Hola! Soy Sofía, del consultorio del Dr. Heriberto Valdivia 😊 Las cicatrices de acné sí se pueden mejorar, y cuánto depende del tipo de cicatriz. ¿Son marcas hundidas, manchas oscuras o las dos?';

const answer = async (reply: string) => {
  const res = await buildFrontDeskAgent().generate(
    [
      { role: 'user', content: PRELOADED },
      { role: 'assistant', content: ANGLE_OPENER },
      { role: 'user', content: reply },
    ],
    {
      requestContext: buildAgentRequestContext({ tenant, turn, provider: evalProvider, model: evalModel, llmApiKey: evalApiKey }),
    },
  );
  if (process.env.EVAL_DEBUG) console.log(`[eval lp5${RED ? ' RED' : ''}]`, res.text);
  return res;
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(q.logBotEvent).mockResolvedValue(undefined);
  vi.mocked(q.getActiveDemoSession).mockResolvedValue(null);
  getAvailability.mockResolvedValue(SLOTS);
});

describe.skipIf(!evalApiKey)('Dr. Heriberto Valdivia — lp5: contesta su caso → dos horarios', () => {
  for (const reply of ['Hundidas', 'Las dos']) {
    it(`"${reply}" → getAvailability y un horario real en ese mismo turno, sin pedir permiso`, async () => {
      const res = await answer(reply);
      const text = res.text.trim().toLowerCase();
      expect(toolIds(res), text).toContain('getAvailability');
      expect(usesRealLabel(text), text).toBe(true);
      expect(text, text).not.toMatch(/te gustar[ií]a (agendar|apartar)|te aparto|te comparto (los )?horarios/);
    }, 120_000);
  }
});
