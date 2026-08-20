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
 * Measured on `gpt-5.6-luna`, 2026-08-20: these are GUARDS, not reproductions. Both money
 * cases still passed 3/3 with their rule deleted from the fixture, and the reason is worth
 * keeping: the `offering` states the same two facts a second time in the price section, so
 * removing one line does not remove the knowledge. That redundancy is deliberate — the
 * rules exist to force the fact into the RIGHT message — but it does mean these cases pin
 * behavior that already holds rather than proving the wording produces it.
 *
 * The info-dump HALF of the price case is a reproduction: with the old structure
 * (contract/payment/invoicing inside the "# Precio" block, and the looser drip wording) it
 * failed 1 of 5; with the facts moved into their own "solo si lo preguntan" sections, 0 of 5.
 *
 * The STALL half is not, and the honest record matters more than a clean story. Fixing the
 * dump introduced it: the price block ended with "Y ahí te paras", meaning stop adding facts,
 * and live (23:10) the model read it as stop and ended the thread on the three numbers with
 * no next step. The wording is now scoped to DATOS and the flow rule is marked as outranking
 * any instruction to stop — a defensible fix aimed at the most plausible cause — but 16 runs
 * across three history shapes, WITH the offending wording restored, never reproduced it:
 * plain history 5/5, history with the close already spent 6/6, and again 5/5 once the turn
 * carried a contactPhone so the prompt matched production's shape. So the fix has an unproven
 * effect and this assertion is a guard. What the live thread proves is that the failure is
 * reachable; what the harness proves is that it is rare enough not to surface in ~16 samples. Note what the first attempt
 * at falsifying it got wrong — reverting only the offering left the tightened drip rule in
 * `qualificationNotes` doing the work, and the case passed 5/5, which would have been read
 * as "does not discriminate". Revert the WHOLE change or the red side is not the old state.
 *
 * The mid-conversation disclosure case has a real incident behind it and still does not
 * discriminate: a played thread (2026-08-20) had the model list "manejo de anuncios" among
 * what's included and stop, so the ad budget arrived a message late. Rebuilt from that exact
 * history the case passes 5/5, with the ambiguous wording AND with the disambiguated one —
 * the miss is a RATE, not a deterministic effect of that phrasing. So: the wording fix is a
 * clarity improvement with unproven effect, the case is a guard, and the failure mode is
 * worth watching in real threads because no eval here reliably provokes it.
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

// A WhatsApp lead arrives WITH a phone, and the prompt branches on it: with one, the
// reminder section says "just book"; without, it tells the agent to ask for the number
// before booking. Leaving it out builds a prompt production never renders — cases here
// were being measured against a shape no real lead of this campaign produces.
const turn: TurnContext = {
  ghlConversationId: 'conv_eval_fit',
  ghlContactId: 'contact_eval_fit',
  contactPhone: '+5216641234567',
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

  // The single-message version of this case passed while the REAL flow failed: asked for
  // the price after qualifying, the model listed "manejo de anuncios" among what's
  // included and stopped — the ad budget arrived a message late, which is exactly the
  // "found out afterwards" this rule exists to prevent. The word "anuncios" inside the
  // included list is what made the omission feel complete.
  it('discloses both halves even when price comes up mid-conversation', async () => {
    const agent = buildFrontDeskAgent();
    const res = await agent.generate(
      [
        { role: 'user', content: 'Hola, vi su anuncio de las citas de botox' },
        { role: 'assistant', content: 'Hola, qué gusto. Somos The Bot Crew: ayudamos a med spas a llenar su agenda de valoraciones de bótox. ¿Ya ofrecen bótox?' },
        { role: 'user', content: 'Tengo un med spa en Guadalajara, aplicamos botox y rellenos. Si me escriben por WhatsApp' },
        { role: 'assistant', content: 'Perfecto, sí les puede servir. ¿Quién contesta esos mensajes hoy?' },
        { role: 'user', content: 'Cuanto cuesta?' },
      ],
      { requestContext: rc() },
    );

    expect(reply(res)).toMatch(/1[,.]?500/);
    // The ad budget, in the SAME message — and "incluye el manejo de anuncios" is not it.
    expect(reply(res)).toMatch(/200|aparte|directo a meta|no incluye|va(n)? por (tu|su) cuenta/);
  });

  // Transcribed from a live thread (2026-08-20, 22:02): asked "¿cuánto cuesta?", Sara
  // answered SEVEN things — price, what's included, no contract, month to month, cancel
  // anytime, payment methods, invoicing. Not the model ignoring the drip rule: the offering
  // kept contract/payment/invoicing INSIDE the "# Precio" section, so the price question
  // pulled the whole block. The facts now live in their own "solo si lo preguntan" sections.
  it('answers the price with the three numbers, and still moves', async () => {
    const agent = buildFrontDeskAgent();
    const res = await agent.generate(
      [
        { role: 'user', content: '¡Hola! Vi su anuncio y me interesa recibir más información.' },
        { role: 'assistant', content: '¡Hola! Soy Sara, de The Bot Crew. Ayudamos a med spas a llenar su agenda de valoraciones de bótox.\n\nPara ubicarme: ¿los mensajes los contestas tú o alguien de tu equipo?' },
        { role: 'user', content: 'Marina, mi recepcionista' },
        { role: 'assistant', content: 'La idea no es reemplazar a Marina, sino cubrirla cuando está en cabina o fuera de horario.\n\n¿Ya han probado anuncios de bótox?' },
        { role: 'user', content: 'Nop, aún no' },
        { role: 'assistant', content: 'Entonces se puede instalar desde cero.\n\n¿Ya ofrecen bótox en la clínica?' },
        { role: 'user', content: 'Sip' },
        // The close is SPENT here. That is the ingredient that made it stall live: the
        // model may not reuse this question, so if the price block also tells it to stop,
        // it has no move left. A history without this line does not reproduce the bug.
        { role: 'assistant', content: 'Entonces sí les puede servir. En una videollamada de 20 minutos, Leo te muestra el sistema funcionando con el caso de tu clínica.\n\n¿Te aparto un espacio con Leo?' },
        { role: 'user', content: 'Cuando me va costar?' },
      ],
      { requestContext: rc() },
    );

    // The three that DO belong together.
    expect(reply(res)).toMatch(/1[,.]?500/);
    expect(reply(res)).toMatch(/200|aparte|directo a meta/);
    // The four that were riding along uninvited.
    expect(reply(res), `info dump: ${res.text}`).not.toMatch(/factura|transferencia|tarjeta de (crédito|debito|débito)/);
    expect(reply(res), `info dump: ${res.text}`).not.toMatch(/sin contrato|plazo forzoso|mes a mes|cancela(n|r)? cuando/);
    // …and it still has to MOVE.
    expect(/\?/.test(reply(res)) || /agend|apart|horario/.test(reply(res)), `sin siguiente paso: ${res.text}`).toBe(true);
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

describe.skipIf(!evalApiKey)('money — where the guarantee stops', () => {
  // The sharpest question a buyer asks, and the one where a generous-sounding answer
  // creates a debt: Leo keeps working for free, but Meta still charges the clinic. Both
  // halves have to travel together or the guarantee reads as "everything is covered".
  it('says the ad spend stays with the clinic even while the guarantee runs', async () => {
    const agent = buildFrontDeskAgent();
    const res = await agent.generate(
      [{ role: 'user', content: 'A ver, si no llegan las 10 citas y sigues trabajando gratis, ¿tú me cubres los anuncios ese tiempo?' }],
      { requestContext: rc() },
    );

    // Not just "ads exist": it has to say who keeps paying for them.
    expect(reply(res)).toMatch(/sigues? (pagando|cubriendo|invirtiendo)|por (tu|su) cuenta|los cubres tú|la clínica|van aparte|directo a meta/);
    expect(reply(res)).not.toMatch(/yo (te )?(cubro|pago) (los )?anuncios|nosotros (cubrimos|pagamos) (los )?anuncios/);
  });

  // The previous offer charged for the software on top (~194 USD/mes). A model that
  // hedges here re-creates a cost the offer no longer has, right at the decision.
  it('answers that the software is included, without inventing a tool to pay for', async () => {
    const agent = buildFrontDeskAgent();
    const res = await agent.generate(
      [{ role: 'user', content: '¿Y tengo que pagar alguna herramienta o suscripción aparte? tipo un CRM' }],
      { requestContext: rc() },
    );

    expect(reply(res)).toMatch(/inclui|incluye|no (tienes|hay) que pagar|sin costo adicional/);
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
