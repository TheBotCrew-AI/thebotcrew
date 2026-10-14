/**
 * Courtesy gate — the bot says goodbye ONCE.
 *
 * After the bot's own goodbye ("¡Con mucho gusto, Perla! Te esperamos"), a lead's
 * "gracias" / 👍 / "bendiciones" got another reply, the lead answered that one, and so
 * on. This gate keeps the turn silent in exactly that case:
 *
 *  1. `courtesyCandidate` (code, free): every lead message since the bot's last message
 *     is short, asks nothing and is not media, and the bot's last message asked nothing.
 *     Anything else — a question on either side, a long message, a photo, a human's
 *     message last — answers as before without spending a call.
 *  2. `classifyCourtesySkip` (one aux call, only for a candidate): was the bot's last
 *     message ALREADY a goodbye, and is the lead only thanking/reacting to it? A booking
 *     confirmation is not a goodbye — the lead's "gracias" to it gets its "con gusto".
 *
 * Bias: when in doubt, reply. A failed or unparseable call replies. Silence never
 * depends on time, so a lead who writes something real a minute or a month later is
 * answered, and one who sends a 👍 a month later is not.
 */

import type { ConversationMessage } from '../core/types.js';
import { auxJsonCompletion, type AuxLlmCall } from './aux-llm.js';
import { formatTail } from './resume-gate.js';

/** Messages shown to the classifier, and read to find the candidate. */
export const COURTESY_TAIL_SIZE = 8;
/** Longer than this, a lead message almost always carries something to answer. */
export const COURTESY_MAX_CHARS = 60;

const asksSomething = (text: string) => /[?¿]/.test(text);
/** `[nota de voz]`, `[imagen]`, `[Foto que mandó: …]`: media is never a courtesy. */
const isMediaMarker = (text: string) => text.trimStart().startsWith('[');

/**
 * The lead messages since the bot's last message, when they could be pure courtesy —
 * `since` is the first of them (what the restore undoes from). null = answer normally.
 */
export function courtesyCandidate(tail: ConversationMessage[]): { since: string } | null {
  let i = tail.length;
  while (i > 0 && tail[i - 1]!.senderType === 'lead') i--;
  const pending = tail.slice(i);
  const before = tail[i - 1];
  if (pending.length === 0 || !before || before.senderType !== 'bot') return null;
  if (asksSomething(before.content)) return null;
  const allCourtesyShaped = pending.every(
    (m) => m.content.trim().length <= COURTESY_MAX_CHARS && !asksSomething(m.content) && !isMediaMarker(m.content),
  );
  return allCourtesyShaped ? { since: pending[0]!.sentAt } : null;
}

export const COURTESY_PROMPT = (tail: ConversationMessage[]) =>
  `Eres el filtro de un asistente que atiende clientes por chat. Decide si el asistente debe contestar los últimos mensajes del cliente o quedarse callado.

Últimos mensajes (del más antiguo al más reciente):
${formatTail(tail)}

skip = true SOLO si se cumplen las dos:
1. El último mensaje del asistente YA FUE UNA DESPEDIDA: le respondió a un agradecimiento o a un cierre del cliente ("¡Con gusto!", "Aquí estamos para lo que necesites", "Te esperamos", "Que tengas lindo día").
2. Lo que el cliente escribió después es solo cortesía o reacción a esa despedida: "gracias", "igualmente", "bendiciones", "ok", "va", un emoji, un like.

skip = false si el último mensaje del asistente dio información, confirmó o agendó una cita, mandó horarios, precios o una dirección — aunque no haga ninguna pregunta: el agradecimiento del cliente a eso merece UNA respuesta.
skip = false si el cliente pide, pregunta, propone, confirma algo nuevo o cambia algo.
Ante la duda, false.

Responde SOLO con JSON: {"skip":true} o {"skip":false}. Sin explicaciones.`;

/** null = the model did not answer the question (empty, malformed, wrong shape). */
export function parseCourtesySkip(raw: string): boolean | null {
  try {
    const parsed = JSON.parse(raw) as { skip?: unknown };
    return typeof parsed.skip === 'boolean' ? parsed.skip : null;
  } catch {
    return null;
  }
}

/** Should this turn stay silent? Defaults to `false` (reply) on any failure. Never throws. */
export async function classifyCourtesySkip(tail: ConversationMessage[], llm: AuxLlmCall): Promise<boolean> {
  try {
    const raw = await auxJsonCompletion(COURTESY_PROMPT(tail), llm, 'courtesy-gate');
    const verdict = parseCourtesySkip(raw);
    if (verdict === null) {
      console.error('[courtesy-gate] unparseable verdict, defaulting to reply:', raw.slice(0, 120));
      return false;
    }
    return verdict;
  } catch (err) {
    console.error('[courtesy-gate] classify failed, defaulting to reply:', err instanceof Error ? err.message : String(err));
    return false;
  }
}
