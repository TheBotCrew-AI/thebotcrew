/**
 * El demo de 4 mensajes que Leo graba en video: el lead llega del anuncio, Vale saluda,
 * ofrece DOS horarios, el lead elige, Vale pide el nombre y con él la cita queda "agendada"
 * (calendario simulado).
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
 * ERA UNA TOMA DE 3 Y SE VOLVIÓ DE 4 (arreglado 2026-09-07). cbdedc6 (08-29) metió el paso
 * del nombre a la secuencia de agendado —"Demo asks too", dice ese commit— y no tocó este
 * archivo, así que llevaba nueve días en rojo sin que nadie lo notara: al elegir el horario,
 * Vale cierra la hora y pregunta "¿A nombre de quién agendo la valoración?" en vez de agendar
 * (0/3: dos corridas sin ninguna herramienta y una re-consultando disponibilidad). No lo rompió
 * el cambio de oferta del tenant — el demo corre sobre su propia persona. También es el
 * recordatorio de que un eval vivo fuera del gate de CI solo falla cuando alguien lo corre.
 * Con el cuarto turno: 3/3.
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

describe.skipIf(!evalApiKey)('demo video — 4 mensajes: saludo → 2 horarios → nombre → agendada', () => {
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
    history.push({ role: 'assistant', content: r3.text });

    // Turn 4 — el nombre. Este lead nunca lo dijo, así que la secuencia de agendado lo pide
    // antes de agendar (cbdedc6): GHL saluda con `{{contact.first_name}}` en su confirmación.
    const LEAD_4 = 'Mariana Ruiz';
    history.push({ role: 'user', content: LEAD_4 });
    const r4 = await agent.generate(history, { requestContext: rc() });
    say(4, 'LEAD', LEAD_4);
    say(4, `SARA (${splitIntoMessages(r4.text).length} burbuja/s) tools=${toolIds(r4).join(',') || 'none'}`, r4.text);

    // What the take needs to hold.
    expect(toolIds(r1)).not.toContain('getAvailability');   // saludo limpio
    expect(r1.text).not.toMatch(/\d{1,2}:\d{2}/);
    expect(toolIds(r2)).toContain('getAvailability');       // 2 horarios reales
    expect(offered.length).toBeGreaterThanOrEqual(2);
    expect(toolIds(r3)).not.toContain('bookAppointment');   // primero el nombre
    expect(r3.text.toLowerCase()).toMatch(/nombre/);
    expect(toolIds(r4)).toContain('bookAppointment');       // agendada
  }, 240_000);
});
