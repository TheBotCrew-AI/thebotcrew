/**
 * Our stored turns → the model's user/assistant view.
 *
 * A human teammate's reply is stored as `sender_type='human_agent'` and used to reach the
 * model as a bare `assistant` message — indistinguishable from the bot's own. That is how
 * MADI's bot, having been told by a person "sí se puede con 17 años, acompañada de un
 * adulto", kept answering "el equipo te confirma": to the model those words were its own,
 * and its prompt forbids it from stating facts it does not have. Attribution is the fix —
 * the prompt then teaches the prefix as "the team's official answer".
 */

import type { ConversationMessage } from './types.js';

export type ChatMessage = { role: 'user'; content: string } | { role: 'assistant'; content: string };

/** Marks a human teammate's message in the history the model reads. Referenced verbatim
 *  by the front-desk prompt — change both or the rule points at nothing. */
export const HUMAN_REPLY_PREFIX = '[Respuesta de una persona del equipo]';

export function toModelMessages(history: ConversationMessage[]): ChatMessage[] {
  return history.map((m): ChatMessage => {
    if (m.senderType === 'lead') return { role: 'user', content: m.content };
    if (m.senderType === 'human_agent') return { role: 'assistant', content: `${HUMAN_REPLY_PREFIX} ${m.content}` };
    return { role: 'assistant', content: m.content };
  });
}

/** Whether a human teammate wrote anything in this history window. */
export function hasHumanReplies(history: ConversationMessage[]): boolean {
  return history.some((m) => m.senderType === 'human_agent');
}
