/**
 * Resume gate — what the bot checks before answering a message that arrived while a
 * human had it paused.
 *
 * A turn suppressed by the sliding human pause is not dropped: the DO re-arms its alarm
 * for when the pause expires and re-runs the turn flagged `resumed`. By then the thread
 * lived a while without the bot, so the normal gates are not enough:
 *
 *  1. Someone may have answered already (the human, usually) — deterministic, see
 *     `hasReplyAfter` in db/queries.
 *  2. The lead's last message may need no answer at all: "Gracias", "ok perfecto", an
 *     emoji after the human resolved everything. Answering that is the bot talking for
 *     the sake of talking — the thing the client noticed first. That is this classifier.
 *
 * Bias: when in doubt, reply. An extra "¡Con gusto!" is a small annoyance; a real
 * question left unanswered is a lost lead. A failed or unparseable call also replies.
 */

import type { ConversationMessage } from '../core/types.js';
import { auxJsonCompletion, type AuxLlmCall } from './aux-llm.js';

/** Messages shown to the classifier — enough for context, not the whole thread. */
export const RESUME_TAIL_SIZE = 8;

const SPEAKER: Record<ConversationMessage['senderType'], string> = {
  lead: 'cliente',
  bot: 'asistente',
  human_agent: 'equipo',
};

export function formatTail(tail: ConversationMessage[]): string {
  return tail.map((m) => `[${SPEAKER[m.senderType]}] ${m.content.slice(0, 300)}`).join('\n');
}

export const NEEDS_REPLY_PROMPT = (tail: ConversationMessage[]) =>
  `Un asistente de ventas estuvo en pausa mientras una persona del equipo atendía esta conversación. La pausa terminó y el último mensaje es del cliente. Decide si ese último mensaje PIDE una respuesta o si la conversación ya quedó resuelta.

Últimos mensajes (del más antiguo al más reciente):
${formatTail(tail)}

needs_reply = true si el cliente pregunta algo, pide información o precios, propone o pide un horario, o deja algo pendiente que nadie respondió después.
needs_reply = false si el último mensaje es solo cortesía o cierre ("gracias", "ok", "perfecto", "nos vemos", "va", un emoji, un sticker), o confirma algo que el equipo ya dejó resuelto.
Ante la duda, true.

Responde SOLO con JSON: {"needs_reply":true} o {"needs_reply":false}. Sin explicaciones.`;

/** null = the model did not answer the question (empty, malformed, wrong shape). */
export function parseNeedsReply(raw: string): boolean | null {
  try {
    const parsed = JSON.parse(raw) as { needs_reply?: unknown };
    return typeof parsed.needs_reply === 'boolean' ? parsed.needs_reply : null;
  } catch {
    return null;
  }
}

/**
 * Does the lead's last message still need an answer? Defaults to `true` on any
 * failure (see the bias note above). Never throws.
 */
export async function classifyNeedsReply(tail: ConversationMessage[], llm: AuxLlmCall): Promise<boolean> {
  if (tail.length === 0) return true;
  try {
    const raw = await auxJsonCompletion(NEEDS_REPLY_PROMPT(tail), llm, 'resume-gate');
    const verdict = parseNeedsReply(raw);
    if (verdict === null) {
      console.error('[resume-gate] unparseable verdict, defaulting to reply:', raw.slice(0, 120));
      return true;
    }
    return verdict;
  } catch (err) {
    console.error('[resume-gate] classify failed, defaulting to reply:', err instanceof Error ? err.message : String(err));
    return true;
  }
}
