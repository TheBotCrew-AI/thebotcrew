/**
 * Dr. Heriberto Valdivia — campañas de recuperación (plantillas bulk de WhatsApp, 0072).
 *
 * La lead habló en septiembre por el anuncio de bótox (a02: precios de jornada, "a más tardar el
 * 30 de septiembre") y se quedó callada. En octubre recibe la plantilla de recuperación (consulta
 * gratis) y aprieta el botón "Quiero mi valoración". Dos cosas tienen que pasar en ese turno:
 *   1. agenda: getAvailability + un horario real, sin volver a preguntar qué le interesa;
 *   2. nada de la promoción muerta: ni $2,125 / $4,200 / $2,999 ni "30 de septiembre".
 *
 * El lado rojo (`HRC_RED=1`) es el mundo antes de 0072: el bulk se perdía en el webhook (la
 * plantilla NO está en el historial), el hilo sigue pineado a a02 (snapshot del incidente, con
 * sus precios de jornada) y no hay sección de campaña en el prompt.
 *
 * MEDIDO 2026-10-14 (gpt-6-luna, high, 3 corridas por lado):
 *   bótox  rojo 0/3 — las tres abren con "Una disculpa, te compartí por error la promoción de
 *          septiembre, que ya terminó" (la lead no mencionó ninguna promoción) · verde 3/3.
 *   láser  rojo 2/3 (el pin a02 es de bótox y el precio vivo del láser ya es el de la base, así
 *          que el rojo casi no muerde aquí; queda como guarda) · verde 3/3.
 *   Un tercer caso ("¿sigue el precio de septiembre?" → $2,500) pasó 3/3 en rojo y 2/3 en verde
 *   (un dodge: "la oferta vigente es la consulta gratis", sin el número): no distingue nada y se
 *   quitó.
 *
 * Live-only (needs an API key); `pnpm eval`, excluded from the CI gate.
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
import { toModelMessages } from '../../../core/model-messages.js';
import type { ConversationMessage, TenantContext, TurnContext } from '../../../core/types.js';
import { heribertoTenant } from './fixtures.js';
import { INCIDENT_A02_OFFERING, INCIDENT_A02_QUALIFICATION_NOTES } from './heriberto-a02-incident.js';
import { evalApiKey, evalModel, evalProvider } from './eval-model.js';

const TZ = 'America/Chihuahua';
const RED = process.env.HRC_RED === '1';

/** La variante delgada de recuperación: un re-pin y la etiqueta del calendario, nada más. */
const tenant: TenantContext = {
  ...heribertoTenant,
  config: {
    ...heribertoTenant.config,
    promptVariants: {
      'r-recup': { repin: true, calendarLabel: 'Recuperación' },
      a02: { offering: INCIDENT_A02_OFFERING, qualificationNotes: INCIDENT_A02_QUALIFICATION_NOTES },
    },
  },
};

const turn: TurnContext = {
  ghlConversationId: 'conv_eval_recovery',
  ghlContactId: 'contact_eval_recovery',
  contactPhone: '+526141234567',
  channel: 'whatsapp',
  promptVariant: RED ? 'a02' : 'r-recup',
  hasCampaignSends: !RED,
};

const nextWeekday = (): string => {
  const d = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
  while ([0, 6].includes(d.getUTCDay())) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};
const DAY = nextWeekday();
const SLOTS = [`${DAY}T16:15:00-06:00`, `${DAY}T18:15:00-06:00`].map((start) => ({ start, end: start }));
const LABELS = SLOTS.map((s) => slotLabel(s.start, TZ, TZ));

const usesRealLabel = (text: string): boolean =>
  LABELS.some((label) => {
    const weekday = label.split(',')[0]!.toLowerCase();
    const time = label.match(/\d{1,2}:\d{2}/)?.[0] ?? '';
    return !!time && text.includes(weekday) && text.includes(time);
  });

type ToolCallChunkLike = { payload: { toolName: string } };
const toolIds = (res: { toolCalls?: ToolCallChunkLike[] }): string[] => (res.toolCalls ?? []).map((c) => c.payload.toolName);

const at = (iso: string): string => `${iso}:00-06:00`;
const lead = (content: string, t: string): ConversationMessage => ({ direction: 'inbound', senderType: 'lead', content, sentAt: at(t) });
const bot = (content: string, t: string): ConversationMessage => ({ direction: 'outbound', senderType: 'bot', content, sentAt: at(t) });
const campaign = (content: string, t: string): ConversationMessage => ({ direction: 'outbound', senderType: 'campaign', content, sentAt: at(t) });

/** Septiembre: el hilo de la jornada de bótox, con sus precios, tal como los decía a02. */
const SEPTEMBER: ConversationMessage[] = [
  lead('Precio', '2026-09-12T11:02'),
  bot('¡Hola! Soy Sofía, del consultorio del Dr. Heriberto Valdivia 😊 Te lo digo directo: el precio es cerrado, por zona, y se paga en el consultorio el día de la cita, sin paquetes ni anticipos. ¿Qué zona te interesa?', '2026-09-12T11:02'),
  lead('La frente y el entrecejo', '2026-09-12T11:10'),
  bot('Frente $2,125 (regular $2,500) y entrecejo $1,700 (regular $2,000). Es el precio de la promoción de septiembre: aplica a las citas que se atienden a más tardar el miércoles 30 de septiembre.', '2026-09-12T11:10'),
  bot('¿Te acomoda más por la mañana o por la tarde para tu consulta con el Dr. Valdivia?', '2026-09-12T11:10'),
  lead('Lo voy a pensar, gracias', '2026-09-12T11:31'),
  bot('Claro, sin presión 😊 Cualquier duda aquí estoy.', '2026-09-12T11:31'),
];

const BOTOX_TEMPLATE = `¡Hola, Ana! 😊
¿Todavía estás pensando en aplicarte bótox, pero te preocupa que tu rostro se vea diferente o poco natural?
¡Es normal tener dudas, sobre todo si es tu primera vez! 💕
Por eso, durante octubre el Dr. Heriberto está ofreciendo consultas GRATIS para ayudarte a decidir.
En tu consulta podrás:
✨ Saber qué arrugas puedes suavizar con bótox.
💕 Conocer cómo lograr un resultado natural, sin cambiar demasiado tus expresiones.
💬 Resolver todas tus dudas directamente con el doctor.
¡Sin costo y sin compromiso!
Y si después de tu consulta te sientes lista, puedes aplicarte el bótox ese mismo día, siempre que el doctor confirme que es adecuado para ti. 💉
¿Te gustaría agendar tu consulta gratis? 😊`;

const LASER_TEMPLATE = `¡Hola, Ana! 😊
¿Todavía estás pensando en hacerte el láser CO₂, pero tienes dudas sobre los resultados o la recuperación?
¡Queremos ayudarte a decidir con tranquilidad! 💕
Durante octubre, el Dr. Heriberto está ofreciendo consultas GRATIS, donde podrás saber si el láser es adecuado para tu piel, qué resultados puedes esperar y cómo sería tu recuperación.
¡Sin costo y sin compromiso de hacerte el tratamiento!
Además, tenemos una promoción especial si decides comenzar en octubre:
✨ $3,500 por sesión (precio normal $4,500).
🎁 Kit de recuperación GRATIS para cuidar tu piel después del láser.
💬 Acompañamiento por WhatsApp durante tu recuperación.
Así puedes resolver todas tus dudas antes de tomar una decisión. 💕
¿Te gustaría agendar tu consulta gratis? 😊`;

/** El hilo de septiembre de láser, para el caso de láser (precio de jornada $2,999). */
const SEPTEMBER_LASER: ConversationMessage[] = [
  lead('Promoción de láser', '2026-09-14T17:40'),
  bot('¡Hola! Soy Sofía, del consultorio del Dr. Heriberto Valdivia 😊 El láser CO₂ tiene precio de promoción de septiembre: $2,999 por sesión (regular $4,500), para sesiones que se atienden a más tardar el 30 de septiembre. ¿Qué te gustaría mejorar: manchas, cicatrices o textura?', '2026-09-14T17:40'),
  lead('Manchas, pero déjame ver', '2026-09-14T18:02'),
  bot('Claro 😊 Aquí estoy para cualquier duda.', '2026-09-14T18:02'),
];

/** Antes de 0072 el webhook tiraba el bulk: la plantilla nunca llegaba al historial. */
const legacyView = (h: ConversationMessage[]) => toModelMessages(h.filter((m) => m.senderType !== 'campaign'));

const generate = async (history: ConversationMessage[]) => {
  const res = await buildFrontDeskAgent().generate(RED ? legacyView(history) : toModelMessages(history), {
    requestContext: buildAgentRequestContext({ tenant, turn, provider: evalProvider, model: evalModel, llmApiKey: evalApiKey }),
  });
  if (process.env.EVAL_DEBUG) console.log(`[eval recovery${RED ? ' RED' : ''}]`, res.text);
  return res;
};

const DEAD_PROMO = /2,?125|1,?700|4,?200|2,?999|30 de septiembre|promoci[oó]n de septiembre/;
const ASKS_WHAT = /qu[eé] tratamiento te interesa|qu[eé] te gustar[ií]a mejorar|en qu[eé] (te|lo) (puedo )?ayud/;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(q.logBotEvent).mockResolvedValue(undefined);
  vi.mocked(q.getActiveDemoSession).mockResolvedValue(null);
  getAvailability.mockResolvedValue(SLOTS);
});

describe.skipIf(!evalApiKey)('Dr. Heriberto Valdivia — recuperación: la plantilla es la oferta vigente', () => {
  it('bótox: "Quiero mi valoración" → horarios reales en ese turno, sin precios de jornada ni volver a preguntar', async () => {
    const res = await generate([...SEPTEMBER, campaign(BOTOX_TEMPLATE, '2026-10-15T10:00'), lead('Quiero mi valoración', '2026-10-15T10:07')]);
    const text = res.text.toLowerCase();
    expect(toolIds(res), text).toContain('getAvailability');
    expect(usesRealLabel(text), text).toBe(true);
    expect(text, text).not.toMatch(DEAD_PROMO);
    expect(text, text).not.toMatch(ASKS_WHAT);
  }, 120_000);

  it('láser: "Quiero mi valoración" → horarios reales, sin el $2,999 de septiembre', async () => {
    const res = await generate([...SEPTEMBER_LASER, campaign(LASER_TEMPLATE, '2026-10-15T10:00'), lead('Quiero mi valoración', '2026-10-15T10:07')]);
    const text = res.text.toLowerCase();
    expect(toolIds(res), text).toContain('getAvailability');
    expect(usesRealLabel(text), text).toBe(true);
    expect(text, text).not.toMatch(DEAD_PROMO);
    expect(text, text).not.toMatch(ASKS_WHAT);
  }, 120_000);
});
