/**
 * Info-gap eval cases — MADI Skin Care.
 *
 * Facts the clinic's team kept answering BY HAND in the WhatsApp threads while the
 * bot said "déjame lo confirmo con el equipo" (see docs/madi-info-gaps.md, cut
 * 2026-08-25). Each describe gates one gap that was closed by moving the team's
 * own answer into the tenant config:
 *
 *   - Formas de pago (gap #1) → `offering`: the package is promotional and paid in
 *     full at the first session; per-session is the fallback; cash/card/transfer.
 *     Ten of the thirty human-touched threads entered on this question alone.
 *   - "Cuerpo completo" (gap #9) → `offering`: it names the axilas + bikini +
 *     piernas completas combo ($3,800), not the $1,900 per-session price the bot
 *     used to lead with.
 *   - Garantía / resultados (gap #5) → `faq`: the technician's answer, reachable
 *     through lookupFaq only when asked.
 *   - Hours (gap #4) → `hours`: the config said Mon–Fri 08:00–17:00 while the team
 *     booked Saturdays, a Sunday and 6:30 pm; the real listing is Mon–Fri 8–19,
 *     Sat–Sun 8–16. With no weekend entry the bot invented one ("sábados de 10:00").
 *
 * The failure mode in every case is the same: a queued `flagPendingInfo` for a fact
 * that IS in the config now — so each case asserts the answer AND that nothing was
 * queued. Shown red first with the fixture lacking the rules (one run, 5/5 cases
 * red, every reply "déjame confirmarlo con el equipo"), then green with them
 * (three runs, 15/15), on gpt-5.6-luna.
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
import type { TurnContext } from '../../../core/types.js';
import { madiTenant } from './fixtures.js';
import { evalApiKey, evalModel, evalProvider } from './eval-model.js';

const turn: TurnContext = {
  ghlConversationId: 'conv_eval_madi_gaps',
  ghlContactId: 'contact_eval_madi_gaps',
  channel: 'whatsapp',
};

const rc = () =>
  buildAgentRequestContext({ tenant: madiTenant, turn, provider: evalProvider, model: evalModel, llmApiKey: evalApiKey });

type ToolCallChunkLike = { payload: { toolName: string } };
const toolIds = (res: { toolCalls?: ToolCallChunkLike[] }): string[] =>
  (res.toolCalls ?? []).map((c) => c.payload.toolName);

const reply = (res: { text: string }) => res.text.trim().toLowerCase();

/** The old behaviour: punting a known fact to the team. */
const PUNTS_TO_TEAM = /confirmo con el equipo|lo confirmo|te aviso|lo reviso con/;

/** A price has already been quoted; the lead now asks how it is paid. */
const AFTER_AXILAS_QUOTE = [
  { role: 'user' as const, content: 'Hola, quiero depilarme las axilas' },
  { role: 'assistant' as const, content: '¡Claro! ¿Se te irrita la piel o te salen bolitas con el rastrillo?' },
  { role: 'user' as const, content: 'Sí, bastante. ¿Cuánto es?' },
  {
    role: 'assistant' as const,
    content: 'Para lo que me cuentas el láser te va a ayudar. Axilas son $2,300 las 6 sesiones. ¿Te acomoda mejor por la mañana o por la tarde?',
  },
];

beforeEach(() => vi.clearAllMocks());

describe.skipIf(!evalApiKey)('MADI — formas de pago (gap #1)', () => {
  it('says the package is paid in full at the first session, without queuing it', async () => {
    const agent = buildFrontDeskAgent();
    const res = await agent.generate(
      [...AFTER_AXILAS_QUOTE, { role: 'user', content: '¿Y se paga todo junto o por sesión?' }],
      { requestContext: rc() },
    );

    expect(reply(res)).toMatch(/primera sesión|completo|todo junto/);
    expect(toolIds(res)).not.toContain('flagPendingInfo');
    expect(reply(res)).not.toMatch(PUNTS_TO_TEAM);
  });

  it('offers the per-session alternative with its price when she asks to pay per session', async () => {
    const agent = buildFrontDeskAgent();
    const res = await agent.generate(
      [...AFTER_AXILAS_QUOTE, { role: 'user', content: '¿Puedo pagarlo por sesiones?' }],
      { requestContext: rc() },
    );

    expect(reply(res)).toMatch(/500/);
    expect(reply(res)).toMatch(/por sesión/);
    expect(toolIds(res)).not.toContain('flagPendingInfo');
  });

  it('confirms card and transfer', async () => {
    const agent = buildFrontDeskAgent();
    const res = await agent.generate(
      [...AFTER_AXILAS_QUOTE, { role: 'user', content: '¿Aceptan tarjeta o transferencia?' }],
      { requestContext: rc() },
    );

    expect(reply(res)).toMatch(/tarjeta/);
    expect(reply(res)).toMatch(/transferencia/);
    expect(toolIds(res)).not.toContain('flagPendingInfo');
  });
});

describe.skipIf(!evalApiKey)('MADI — "cuerpo completo" is the $3,800 combo (gap #9)', () => {
  it('quotes the combined package, not the per-session price', async () => {
    const agent = buildFrontDeskAgent();
    const res = await agent.generate(
      [
        { role: 'user', content: 'Hola, ¿cuánto cuesta la depilación de cuerpo completo?' },
        { role: 'assistant', content: '¡Hola! Ahorita te paso el costo; nada más para recomendarte bien: ¿se te irrita la piel con el rastrillo o la cera?' },
        { role: 'user', content: 'Sí, con el rastrillo se me irrita mucho' },
      ],
      { requestContext: rc() },
    );

    expect(reply(res)).toMatch(/3[.,]?800/);
    expect(reply(res)).not.toMatch(/1[.,]?900/);
    expect(toolIds(res)).not.toContain('flagPendingInfo');
  });
});

describe.skipIf(!evalApiKey)('MADI — garantía y resultados come from the FAQ (gap #5)', () => {
  it('answers from lookupFaq instead of queuing it for the team', async () => {
    const agent = buildFrontDeskAgent();
    const res = await agent.generate(
      [
        { role: 'user', content: 'Ya me hice láser en otro lado y no me funcionó. ¿Ustedes dan garantía si no veo ningún cambio?' },
      ],
      { requestContext: rc() },
    );

    expect(toolIds(res)).toContain('lookupFaq');
    expect(toolIds(res)).not.toContain('flagPendingInfo');
    // The technician's answer: no laser removes 100%, 75–80% is typical, a yearly retoque.
    expect(reply(res)).toMatch(/75|80|retoque|100\s?%|ning[uú]n (láser|laser|equipo)|ninguna (máquina|maquina|depilación)/);
    expect(reply(res)).not.toMatch(PUNTS_TO_TEAM);
  });
});

describe.skipIf(!evalApiKey)('MADI — weekend and evening hours (gap #4)', () => {
  // `hours` said Mon–Fri 08:00–17:00 while the team booked Saturdays, a Sunday and
  // 6:30 pm; asked "¿abren sábado?" the bot answered "todos los días de 08:00 a 17:00".
  // The real schedule (the clinic's own listing): Mon–Fri 8–19, Sat–Sun 8–16.
  it('says Saturday is open until 4 pm', async () => {
    const agent = buildFrontDeskAgent();
    const res = await agent.generate(
      [
        { role: 'user', content: 'Hola, ¿abren los sábados? ¿Hasta qué hora?' },
      ],
      { requestContext: rc() },
    );

    expect(reply(res)).toMatch(/s[áa]bado/);
    // "4:00 p.m.", "4 pm", "16:00" — assert the closing hour, not one spelling of it.
    expect(reply(res)).toMatch(/\b4(:00)?\s?(pm|p\.\s?m\.?|de la tarde)|16:00|16 h|cuatro/);
    expect(reply(res)).not.toMatch(/17:00|\b5(:00)?\s?(pm|p\.\s?m\.?)|cinco de la tarde/);
    expect(toolIds(res)).not.toContain('flagPendingInfo');
  });

  it('does not turn away a weekday 6 pm request', async () => {
    // Two legitimate answers here: state the hours (closes at 7) or, since a person
    // books in MADI, go straight to "reviso disponibilidad". Both engage with the slot.
    // The failure is the old one — "cerramos a las 5" — so that is what the case forbids.
    const agent = buildFrontDeskAgent();
    const res = await agent.generate(
      [
        { role: 'user', content: 'Salgo del trabajo a las 6, ¿puedo ir entre semana a las 6 de la tarde?' },
      ],
      { requestContext: rc() },
    );

    expect(reply(res)).toMatch(/\b6(:00)?\b|seis|\b7(:00)?\b|19:00|disponibilidad|espacio/);
    expect(reply(res)).not.toMatch(/cerramos a las 5|hasta las 5|17:00|\b5(:00)?\s?(pm|p\.\s?m\.?)|no (alcanza|se puede|podr)/);
    expect(toolIds(res)).not.toContain('flagPendingInfo');
  });
});

describe.skipIf(!evalApiKey)('MADI — second round of closed gaps (2026-08-25, Leo)', () => {
  // Leo's answers to the tracker's open questions: use Marina's own description of
  // the equipment (Triodo Diamond) and of bikini vs brasileño (same package price,
  // different per-session price); there is one location; no vacancies, no CV inbox.
  it('names the Triodo Diamond when asked what laser they use', async () => {
    const agent = buildFrontDeskAgent();
    const res = await agent.generate(
      [{ role: 'user', content: '¿Qué tipo de láser usan? ¿Es de diodo o cuál?' }],
      { requestContext: rc() },
    );

    expect(reply(res)).toMatch(/triodo/);
    expect(toolIds(res)).not.toContain('flagPendingInfo');
  });

  it('prices a single brasileño session at $600, not the $500 of the regular bikini', async () => {
    const agent = buildFrontDeskAgent();
    const res = await agent.generate(
      [
        { role: 'user', content: 'Quiero el bikini brasileño, pero solo una sesión por ahora' },
        { role: 'assistant', content: '¡Claro! ¿Se te irrita la piel o te salen bolitas con el rastrillo?' },
        { role: 'user', content: 'Sí. ¿Cuánto cuesta la sesión suelta de brasileño?' },
      ],
      { requestContext: rc() },
    );

    expect(reply(res)).toMatch(/600/);
    expect(reply(res)).toMatch(/por sesión/);
    expect(toolIds(res)).not.toContain('flagPendingInfo');
  });

  it('says there is only the Tijuana location, without queuing it', async () => {
    const agent = buildFrontDeskAgent();
    const res = await agent.generate(
      [{ role: 'user', content: 'Hola, ¿tienen sucursal en La Paz o en otro estado?' }],
      { requestContext: rc() },
    );

    expect(reply(res)).toMatch(/tijuana/);
    expect(reply(res)).toMatch(/solo|única|únicamente|no (tenemos|contamos)/);
    expect(toolIds(res)).not.toContain('flagPendingInfo');
    expect(reply(res)).not.toMatch(PUNTS_TO_TEAM);
  });

  it('answers a job seeker with "no vacancies" and does not collect a CV', async () => {
    const agent = buildFrontDeskAgent();
    const res = await agent.generate(
      [{ role: 'user', content: 'Buenas tardes, ¿tienen alguna vacante para recepción? Puedo mandar mi CV' }],
      { requestContext: rc() },
    );

    expect(reply(res)).toMatch(/no (tenemos|hay|contamos con) vacantes|sin vacantes/);
    expect(reply(res)).not.toMatch(/correo|email|mándalo|envíalo|manda(me)? (tu|el) cv/);
    expect(toolIds(res)).not.toContain('flagPendingInfo');
  });
});

describe.skipIf(!evalApiKey)('MADI — the combos the team kept quoting by hand (gap #2)', () => {
  // Six combinations the config lacked while the team priced them in chat; loaded
  // 2026-08-25 as normal package prices (Leo: "promo" is just what the team calls
  // them). Axilas + piernas completas was the most-asked one — three leads, and one
  // of them never got an answer from anyone.
  it('quotes axilas + piernas completas at $3,400 instead of queuing it', async () => {
    const agent = buildFrontDeskAgent();
    const res = await agent.generate(
      [
        { role: 'user', content: 'Hola, quiero cotizar axilas y piernas completas' },
        { role: 'assistant', content: '¡Claro! ¿Se te irrita la piel o te salen bolitas con el rastrillo?' },
        { role: 'user', content: 'Sí, bastante. ¿Cuánto sale el paquete?' },
      ],
      { requestContext: rc() },
    );

    expect(reply(res)).toMatch(/3[.,]?400/);
    expect(toolIds(res)).not.toContain('flagPendingInfo');
    expect(reply(res)).not.toMatch(PUNTS_TO_TEAM);
  });

  it('quotes cara + glúteos at $3,200 — glúteos exists only inside this combo', async () => {
    const agent = buildFrontDeskAgent();
    const res = await agent.generate(
      [
        { role: 'user', content: 'Me interesa depilación láser en cara y glúteos' },
        { role: 'assistant', content: '¡Va! ¿Se te irrita la piel con el rastrillo o la cera?' },
        { role: 'user', content: 'Sí. ¿Cuánto cuesta?' },
      ],
      { requestContext: rc() },
    );

    expect(reply(res)).toMatch(/3[.,]?200/);
    expect(toolIds(res)).not.toContain('flagPendingInfo');
  });
});

// A lead asked "¿con cuánto aparto el paquete?" (first automated report, gap 'apartado
// paquete'). Leo: there is no deposit — paying in full IS how the price is secured. The
// payment rule already implied it: this case was green 3/3 BEFORE the explicit
// "tampoco hay anticipos" line was added; it goes red only with the payment section
// removed, same as the gap #1 cases. Kept as the regression guard for that section.
describe.skipIf(!evalApiKey)('MADI — no deposit: the package price is secured by paying it in full (Leo, 2026-08-25)', () => {
  it('answers "¿con cuánto aparto?" with the full-payment rule instead of queuing it', async () => {
    const agent = buildFrontDeskAgent();
    const res = await agent.generate(
      [
        ...AFTER_AXILAS_QUOTE,
        { role: 'user', content: 'Sería para la otra semana. ¿Con cuánto aparto el paquete para que me respeten el precio?' },
      ],
      { requestContext: rc() },
    );

    expect(reply(res)).toMatch(/completo|primera sesión|no (hay|manejamos|se requiere) (anticipo|apartado)/);
    expect(toolIds(res)).not.toContain('flagPendingInfo');
    expect(reply(res)).not.toMatch(PUNTS_TO_TEAM);
  });
});
