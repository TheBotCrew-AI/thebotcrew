/**
 * El demo de 3 mensajes que Leo graba en video: el lead llega del anuncio, Vale saluda,
 * ofrece DOS horarios, el lead elige y la cita queda "agendada" (calendario simulado).
 *
 * A diferencia del resto de este directorio, este caso no defiende UNA regla: ensaya la
 * toma completa e IMPRIME la transcripción, para poder ver los mensajes exactos (y los
 * horarios que el simulador va a ofrecer hoy) antes de encender la cámara. Se corre solo:
 *   pnpm rehearse
 *
 * MEDIDO en gpt-5.6-luna, 2026-08-27, 7 corridas: 7/7 con la forma pedida — saludo sin
 * horarios (1 burbuja) → disponibilidad + horarios reales → bookAppointment y confirmación.
 * Las 4 primeras corridas fueron ANTES de quitarle a `getAvailability` el "(tres como
 * máximo)": ofrecían 3 horarios en 2 de 4. Con "exactamente DOS", 3/3 ofrecieron dos.
 *
 * Como guardia de regresión es débil por diseño (la mitad de sus aserciones las cubre
 * mejor demo-botox.eval.ts, caso por caso); su valor es el ensayo.
 *
 * Live-only (necesita API key), excluido del gate de CI.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ModelMessage } from 'ai';

vi.mock('../../../db/queries.js');
vi.mock('../../../ghl/client.js', () => ({
  GhlClient: vi.fn(() => ({ addContactTags: vi.fn().mockResolvedValue(undefined) })),
}));

import * as q from '../../../db/queries.js';
import { buildFrontDeskAgent } from '../agent.js';
import { buildAgentRequestContext } from '../../../core/runtime-context.js';
import type { TurnContext } from '../../../core/types.js';
import { simulatedSlots } from '../tools/demo-sim.js';
import { splitIntoMessages } from '../../../worker/webhook-handler.js';
import { botCrewDemoTenant } from './fixtures.js';
import { evalApiKey, evalModel, evalProvider } from './eval-model.js';

const CONV = 'conv_demo_video_rehearsal';
const TZ = 'America/Tijuana';

const turn: TurnContext = {
  ghlConversationId: CONV,
  ghlContactId: 'contact_demo_video',
  channel: 'whatsapp',
  activeRole: 'demo',
};

const rc = () =>
  buildAgentRequestContext({ tenant: botCrewDemoTenant, turn, provider: evalProvider, model: evalModel, llmApiKey: evalApiKey });

type ToolCallChunkLike = { payload: { toolName: string; args?: unknown } };
const toolIds = (res: { toolCalls?: ToolCallChunkLike[] }): string[] =>
  (res.toolCalls ?? []).map((c) => c.payload.toolName);

const LEAD_1 = 'Hola! vi su anuncio del bótox, me pueden dar informes?';
const LEAD_2 = 'Sí, es mi primera vez y me interesa el entrecejo. ¿Puedo ir esta semana en la tarde?';

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(q.getActiveDemoSession).mockResolvedValue(null);
  vi.mocked(q.logBotEvent).mockResolvedValue(undefined);
});

describe.skipIf(!evalApiKey)('demo video — 3 mensajes: saludo → 2 horarios → agendada', () => {
  it('runs the scripted take', async () => {
    const agent = buildFrontDeskAgent();
    const slots = simulatedSlots(CONV, TZ, Date.now());
    const labels = slots.map((s) => s.label);
    const history: ModelMessage[] = [];
    const say = (n: number, who: string, text: string) =>
      console.log(`\n--- ${n}. ${who} ---\n${text}`);

    // Turn 1 — the ad message.
    history.push({ role: 'user', content: LEAD_1 });
    const r1 = await agent.generate(history, { requestContext: rc() });
    say(1, 'LEAD', LEAD_1);
    say(1, `SARA (${splitIntoMessages(r1.text).length} burbuja/s) tools=${toolIds(r1).join(',') || 'none'}`, r1.text);
    history.push({ role: 'assistant', content: r1.text });

    // Turn 2 — the lead gives the facts and asks for an appointment.
    history.push({ role: 'user', content: LEAD_2 });
    const r2 = await agent.generate(history, { requestContext: rc() });
    say(2, 'LEAD', LEAD_2);
    say(2, `SARA (${splitIntoMessages(r2.text).length} burbuja/s) tools=${toolIds(r2).join(',') || 'none'}`, r2.text);
    history.push({ role: 'assistant', content: r2.text });

    // Turn 3 — the lead picks whichever slot the bot actually offered.
    const offered = labels.filter((l) => {
      const day = l.split(',')[0]!.toLowerCase();
      const time = l.match(/\d{1,2}:\d{2}/)?.[0] ?? '';
      return !!time && r2.text.toLowerCase().includes(day) && r2.text.includes(time);
    });
    console.log(`\n[slots simulados] ${labels.join(' | ')}`);
    console.log(`[ofrecidos en msg 2] ${offered.join(' | ') || 'NINGUNO'}`);
    const pick = offered[0] ?? labels[0]!;
    const LEAD_3 = `Perfecto, el ${pick.toLowerCase()} me queda bien`;
    history.push({ role: 'user', content: LEAD_3 });
    const r3 = await agent.generate(history, { requestContext: rc() });
    say(3, 'LEAD', LEAD_3);
    say(3, `SARA (${splitIntoMessages(r3.text).length} burbuja/s) tools=${toolIds(r3).join(',') || 'none'}`, r3.text);

    // What the take needs to hold.
    expect(toolIds(r1)).not.toContain('getAvailability');   // saludo limpio
    expect(r1.text).not.toMatch(/\d{1,2}:\d{2}/);
    expect(toolIds(r2)).toContain('getAvailability');       // 2 horarios reales
    expect(offered.length).toBeGreaterThanOrEqual(2);
    expect(toolIds(r3)).toContain('bookAppointment');       // agendada
  }, 180_000);
});
