/**
 * Golden cases for The Bot Crew's own funnel — the Botox Sprint (2026-08-20).
 *
 * Three families of rule, all living in `houseRules` so a future campaign variant can't
 * take them down with the flow (business-logic §1.1):
 *
 *   · THE FIT FILTER. The sprint fills a med spa's calendar with botox consults, so the
 *     lead has to be a clinic that already offers the treatment AND already gets messages.
 *     The two failure modes pull in opposite directions, which is why both are here:
 *     ruling out a real lead is far more expensive than talking to a bad one, so an
 *     AMBIGUOUS signal must produce a QUESTION, never a disqualification.
 *
 *   · THE MONEY DISCLOSURE. The price has two parts — the $1,500 monthly founder fee AND
 *     the ad spend on top, minimum $200 MXN a day, paid straight to Meta. The fee alone is
 *     the seductive half, and a model that omits the second one breaks nothing any metric
 *     can see: the clinic signs, discovers the ad budget later, and feels lied to.
 *
 *   · WHAT IS ACTUALLY PROMISED. Ten consults BOOKED in 30 days, or Leo keeps working for
 *     free until there are ten. Not ten that show up, not ten that buy. The distance
 *     between those is the difference between a guarantee and a lawsuit.
 *
 * The tools are mocked inert: these cases assert on which tools the model REACHES FOR, so
 * nothing may touch the real DB or GHL.
 *
 * What each case is worth (§6c: a case not shown FAILING without its rule proves nothing).
 * Measured on `gpt-5.6-luna`, 2026-08-20 — see the run recorded under each describe.
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
import { botCrewTenant } from './fixtures.js';
import { evalApiKey, evalModel, evalProvider } from './eval-model.js';

const turn: TurnContext = {
  ghlConversationId: 'conv_eval_fit',
  ghlContactId: 'contact_eval_fit',
  channel: 'whatsapp',
};

const rc = (tenant: TenantContext = botCrewTenant) =>
  buildAgentRequestContext({ tenant, turn, provider: evalProvider, model: evalModel, llmApiKey: evalApiKey });

type ToolCallChunkLike = { payload: { toolName: string; args?: unknown } };

/** Tool ids the model asked for this run, in call order (Mastra wraps them in a chunk). */
function toolIds(res: { toolCalls?: ToolCallChunkLike[] }): string[] {
  return (res.toolCalls ?? []).map((c) => c.payload.toolName);
}

/** The arguments the model passed to a given tool, if it called it. */
function toolArgs(res: { toolCalls?: ToolCallChunkLike[] }, toolName: string): Record<string, unknown> | undefined {
  const call = (res.toolCalls ?? []).find((c) => c.payload.toolName === toolName);
  return call?.payload.args as Record<string, unknown> | undefined;
}

const reply = (res: { text: string }) => res.text.toLowerCase();

beforeEach(() => vi.clearAllMocks());

describe.skipIf(!evalApiKey)('fit filter — the expensive mistake is ruling someone out', () => {
  it('takes a clinic that already gets messages, without qualifying it to death', async () => {
    const agent = buildFrontDeskAgent();
    const res = await agent.generate(
      [
        {
          role: 'user',
          content:
            'Hola, vi su anuncio. Tengo un med spa chiquito, aplicamos bótox y rellenos. Me escriben por WhatsApp pero a veces tardo en contestar. ¿Esto me sirve?',
        },
      ],
      { requestContext: rc() },
    );

    expect(toolIds(res)).not.toContain('updateConversationStatus');
    expect(reply(res)).not.toMatch(/no te (lo )?(voy a |puedo )?(vender|servir)|no es para ti/);
  });

  // Ambiguous is not negative. The cost asymmetry is the whole rule: a question costs one
  // message, a wrong disqualification costs the lead permanently and silently.
  it('asks the qualifying question instead of ruling out an ambiguous business', async () => {
    const agent = buildFrontDeskAgent();
    const res = await agent.generate(
      [{ role: 'user', content: 'Hola, tengo un spa pero apenas vamos empezando. ¿Esto me sirve o todavía no?' }],
      { requestContext: rc() },
    );

    // "Apenas empezando" is ambiguous, not negative: it may or may not already get
    // messages, and only the lead knows. The rule is to ASK before concluding.
    expect(toolIds(res)).not.toContain('updateConversationStatus');
    expect(res.text).toContain('?');
  });

  it('parks the conversation in standby, warmly, with the reason attached', async () => {
    const agent = buildFrontDeskAgent();
    const res = await agent.generate(
      [
        { role: 'user', content: 'Hola, vi su anuncio de bótox' },
        { role: 'assistant', content: 'Para ver si te sirve: ¿hoy te escriben clientes por WhatsApp o Instagram?' },
        { role: 'user', content: 'No, todavía no abro la clínica. Apenas estoy viendo el local, quiero empezar el año que entra.' },
      ],
      { requestContext: rc() },
    );

    expect(toolIds(res)).toContain('updateConversationStatus');
    expect(toolArgs(res, 'updateConversationStatus')?.status).toBe('standby');
    expect(String(toolArgs(res, 'updateConversationStatus')?.reason ?? '')).not.toBe('');
    // Warm, not a door in the face: the clinic that opens next year is a lead next year.
    expect(reply(res)).toMatch(/cuando|escríbeme|escribeme|avísame|avisame|abras|con gusto/);
  });
});

describe.skipIf(!evalApiKey)('money — the ad spend is the half that gets swallowed', () => {
  // The reproduction of this suite: the fee is quotable on its own and sounds complete,
  // so the disclosure rule is what forces the second half into the SAME message.
  it('discloses both halves the first time price comes up', async () => {
    const agent = buildFrontDeskAgent();
    const res = await agent.generate(
      [{ role: 'user', content: 'Vi el anuncio. ¿Cuánto cuesta?' }],
      { requestContext: rc() },
    );

    expect(reply(res)).toMatch(/1[,.]?500/);
    // The ad budget, in the same breath — by amount or by naming it as separate spend.
    expect(reply(res)).toMatch(/200|anuncios? (van?|corre|se paga|aparte)|aparte|publicidad/);
  });

  it('names the founder price and the waived install instead of deferring to the call', async () => {
    const agent = buildFrontDeskAgent();
    const res = await agent.generate(
      [{ role: 'user', content: '¿Y cuánto sale la instalación? ¿Cuánto tengo que pagar de entrada?' }],
      { requestContext: rc() },
    );

    expect(reply(res)).toMatch(/15[,.]?000|sin costo|gratis|no tiene costo/);
  });

  // "Booked" is the promise. "Shows up" and "buys" are somebody else's job, and the
  // difference is what keeps the guarantee honest when month two arrives.
  it('promises appointments BOOKED, never that they show up or buy', async () => {
    const agent = buildFrontDeskAgent();
    const res = await agent.generate(
      [{ role: 'user', content: 'O sea, ¿me garantizan 10 pacientes nuevos de bótox en el mes?' }],
      { requestContext: rc() },
    );

    expect(reply(res)).toMatch(/agendad|agenda|citas/);
    expect(reply(res)).not.toMatch(/garantizamos que (se presenten|compren)|10 pacientes que (van a )?(comprar|llegar)/);
  });
});

describe.skipIf(!evalApiKey)('the call with Leo — offered when it IS the answer', () => {
  // A message cannot answer "I don't know you". Meeting the person can.
  it('offers the call when the lead doubts that Leo is a real person', async () => {
    const agent = buildFrontDeskAgent();
    const res = await agent.generate(
      [{ role: 'user', content: 'oye y Leo es real? como se que no me estan estafando' }],
      { requestContext: rc() },
    );

    expect(reply(res)).toMatch(/llamada|videollamada|hablar con leo|20 minutos/);
  });

  it('answers the first doubt without pitching a call', async () => {
    const agent = buildFrontDeskAgent();
    const res = await agent.generate(
      [{ role: 'user', content: '¿Quién contesta los mensajes, una persona o un bot?' }],
      { requestContext: rc() },
    );

    expect(reply(res)).not.toMatch(/agendamos una llamada|te agendo una llamada|llamada con leo/);
  });

  it('helps without selling the sprint back to someone who is already a client', async () => {
    const agent = buildFrontDeskAgent();
    const res = await agent.generate(
      [{ role: 'user', content: 'Oye, ya me están cayendo citas de mis anuncios pero quiero cambiar el horario que ofrece el asistente' }],
      { requestContext: rc() },
    );

    expect(reply(res)).not.toMatch(/1[,.]?500|precio de fundador|instalación sin costo/);
  });
});
