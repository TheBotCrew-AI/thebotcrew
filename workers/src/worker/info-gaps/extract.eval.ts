/**
 * Info-gap extraction — golden case on a REAL MADI thread (conversation 54fdd449,
 * 2026-08-10): the lead asked five times whether she could pay per session, the bot
 * queued it five times, and a person finally answered "$500 por sesión".
 *
 * Two runs of the same transcript, two configs:
 *   - the OLD offering (payment listed as "not confirmed") → the extractor must
 *     surface a `formas_pago` gap with the human's answer and `already_in_config:false`;
 *   - the NEW offering (the payment section loaded 2026-08-25) → the same question is
 *     now a prompt bug: `already_in_config:true` (the bot had it and still deflected).
 *
 * That verdict is the reason the config travels in the prompt at all, so it is the
 * one thing this case checks beyond "it found the gap".
 *
 * Live-only (needs an API key); `pnpm eval`, excluded from the CI gate.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../db/queries.js');

import { auxJsonCompletion, type AuxLlmCall } from '../aux-llm.js';
import { evalApiKey, evalModel, evalProvider } from '../../roles/front-desk/evals/eval-model.js';
import { buildExtractionPrompt, parseExtraction, type TranscriptLine } from './extract.js';
import { EXTRACTION_MAX_TOKENS } from '../info-gap-runner.js';

const llm: AuxLlmCall = {
  clientId: 'eval',
  ghlConversationId: 'eval-info-gaps',
  provider: evalProvider,
  apiKey: evalApiKey,
  model: evalModel,
  keySource: 'platform',
};

const L = (sender: TranscriptLine['sender'], at: string, text: string): TranscriptLine => ({ sender, at: `2026-08-10T${at}:00Z`, text });

/** Conversation 54fdd449, verbatim (times in UTC). */
const TRANSCRIPT: TranscriptLine[] = [
  L('lead', '22:57', '¡Hola! Quiero más información.'),
  L('bot', '22:57', '¡Hola! Soy Majo, de MADI Skin Care. ¿Cómo te puedo apoyar hoy?'),
  L('lead', '22:58', 'Me podría dar información'),
  L('bot', '22:58', 'Claro, con gusto. ¿Qué te interesa más: faciales, depilación láser o retiro de tatuajes?'),
  L('lead', '23:09', 'Depilación láser'),
  L('bot', '23:10', 'Perfecto — ahorita te paso el costo; ¿qué zona quieres tratar y se te irrita o te salen bolitas con el rastrillo o la cera?'),
  L('lead', '23:15', 'Bikini'),
  L('bot', '23:15', 'Perfecto, bikini: para eso usamos Láser de Diodo, cómodo y prácticamente indoloro. El paquete es de 6 sesiones (una cada mes) y cuesta $2,400. ¿Te acomoda mejor por la mañana o por la tarde?'),
  L('lead', '23:16', 'Tendría que pagar 2400 ya'),
  L('lead', '23:16', 'Oh puedo pagarlo por sesiones'),
  L('bot', '23:16', 'Déjame lo confirmo con el equipo y te aviso. ¿Quieres que te agende la primera sesión cuando lo confirme?'),
  L('lead', '23:17', 'Si'),
  L('lead', '23:17', 'Por favor'),
  L('bot', '23:17', 'Perfecto — déjame lo confirmo con el equipo y te aviso. ¿Te acomoda mejor por la mañana o por la tarde?'),
  L('lead', '23:20', 'Mañana'),
  L('bot', '23:21', 'Perfecto — voy a revisar la disponibilidad y te confirmo en un momento. Déjame lo confirmo con el equipo sobre si se puede pagar por sesiones y te aviso. ¿Quieres que te reserve para mañana en la mañana?'),
  L('lead', '23:24', 'No. Primero quiero que me confirmo si se puede hacer los pagos así ?'),
  L('bot', '23:24', 'Déjame lo confirmo con el equipo y te aviso. Si se puede pagar por sesiones, ¿quieres que proceda a agendar tu primera sesión para la mañana?'),
  L('lead', '23:33', 'Primero ocupo saber si se puede pagar por sesiones ?'),
  L('bot', '23:34', 'Déjame lo confirmo con el equipo y te aviso. Si confirman que sí se puede pagar por sesiones, ¿quieres que agende tu primera sesión para la mañana?'),
  L('human', '23:35', 'El costo de la sesión para bikini es de 500 pesos'),
  L('human', '23:40', 'Por sesión siempre el costo es un poquito más elevado pero si se le hace más cómodo puede hacerlo así mejor'),
];

const OLD_OFFERING = `Depilación láser — zonas individuales (paquete de 6 sesiones):
- Bikini brasileño: $2,400 — 30 min por sesión
- Axilas: $2,300 — 20 min por sesión

Lo que AÚN no tienes confirmado (NO lo inventes): formas de pago, planes o mensualidades, cuidados posteriores, políticas de cancelación. Si preguntan algo de esto, dile que lo confirmas con el equipo y llama flagPendingInfo.`;

const NEW_OFFERING = `Depilación láser — zonas individuales (paquete de 6 sesiones):
- Bikini brasileño: $2,400 — 30 min por sesión
- Axilas: $2,300 — 20 min por sesión

Depilación láser — precio por sesión suelta: Bikini $500 · Axilas $500

Formas de pago (dilas cuando pregunten cómo se paga, si es por sesión o todo junto):
- El precio de paquete es promocional y se paga COMPLETO en la primera sesión.
- Si prefiere pagar por sesión, sí se puede: se cobra el precio por sesión suelta de su zona, que sale un poco más caro que el paquete.
- Aceptan efectivo, tarjeta de crédito o débito y transferencia.

Lo que AÚN no tienes confirmado (NO lo inventes): cuidados posteriores, políticas de cancelación.`;

async function extract(offering: string) {
  const prompt = buildExtractionPrompt({
    businessName: 'MADI Skin Care',
    transcript: TRANSCRIPT,
    offering,
    faq: [{ q: '¿Dónde están ubicados?', a: 'Plaza Financiera, Zona Río, Tijuana.' }],
    hours: '- Lunes a viernes: 08:00–19:00',
  });
  return parseExtraction(await auxJsonCompletion(prompt, llm, 'info_gap_extract', EXTRACTION_MAX_TOKENS));
}

describe.skipIf(!evalApiKey)('info-gap extraction — MADI conversation 54fdd449 (pay per session)', () => {
  it('with the OLD config: a formas_pago gap, the human answer, not in config', async () => {
    const result = await extract(OLD_OFFERING);
    const gap = result.gaps.find((g) => g.topic === 'formas_pago');
    expect(gap, JSON.stringify(result)).toBeDefined();
    expect(gap!.already_in_config).toBe(false);
    expect(gap!.target).toBe('offering');
    expect(gap!.human_answer ?? '').toMatch(/500/);
    expect(gap!.suggested_text ?? '').toMatch(/sesi[oó]n/);
    // The question is the lead's own words, not a paraphrase.
    expect(gap!.question.toLowerCase()).toMatch(/pagar|pagos|sesiones/);
  });

  it('with the NEW config: the same question is a prompt bug (already_in_config)', async () => {
    const result = await extract(NEW_OFFERING);
    const payment = result.gaps.filter((g) => g.topic === 'formas_pago');
    for (const g of payment) {
      expect(g.already_in_config, JSON.stringify(g)).toBe(true);
      expect(g.target).toBe('prompt_bug');
    }
  });
});
