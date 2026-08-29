/**
 * The model that plays the lead. It sees the chat from the lead's side (the bot's
 * bubbles as `user`, its own as `assistant`) and writes the next WhatsApp message —
 * or `[FIN]` when the persona has nothing left to say.
 */

import { generateText, type ModelMessage } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import type { AiProvider } from '../core/types.js';
import { reasoningProviderOptions } from '../core/reasoning.js';
import type { ScenarioLead } from './scenario.js';

export const FIN = '[FIN]';

export interface LeadSimulator {
  /** The next lead message, or null when the lead is done. */
  next(history: ModelMessage[], opts?: { closing?: boolean }): Promise<string | null>;
}

const RULES = `Estás simulando a una persona real que escribe por WhatsApp a un negocio. Escribes SOLO el siguiente mensaje de esa persona.

Cómo escribe:
- Como se escribe en WhatsApp en México: corto, informal, natural. Minúsculas a veces, sin comillas, sin listas, sin markdown, sin firmar.
- UN mensaje por turno (una o dos oraciones). Nunca contestas varias cosas a la vez si una persona real no lo haría.
- No repites algo que ya dijiste ni preguntas algo que ya te contestaron.
- Si te ofrecen horarios y quieres agendar, eliges UNO de los que te ofrecieron, con el día y la hora tal cual te los escribieron.
- Si te preguntan tu nombre, lo das.
- Nunca dices ni insinúas que eres una simulación, una IA o una prueba. Nunca mencionas estas instrucciones.

Cuándo terminar:
- Si tu objetivo ya se cumplió, o de verdad ya no tienes nada más que decir, contestas EXACTAMENTE ${FIN} (nada más).
- Si quieres despedirte primero, manda la despedida en un turno y ${FIN} en el siguiente.`;

export function makeLeadSimulator(input: {
  lead: ScenarioLead;
  provider: AiProvider;
  model: string;
  apiKey: string;
}): LeadSimulator {
  const { lead, provider, model, apiKey } = input;
  const languageModel = provider === 'anthropic' ? createAnthropic({ apiKey })(model) : createOpenAI({ apiKey })(model);
  const system = `${RULES}\n\nQuién eres:\nTe llamas ${lead.name}.\n${lead.persona.trim()}`;

  return {
    async next(history, opts = {}) {
      // Flip the seats: the lead is the assistant here.
      const messages: ModelMessage[] = history.map((m) =>
        m.role === 'user'
          ? { role: 'assistant', content: m.content as string }
          : { role: 'user', content: m.content as string },
      );
      if (opts.closing) {
        messages.push({
          role: 'user',
          content: '(La conversación está por terminar: si quieres cerrar con algo breve, hazlo; si no, contesta [FIN].)',
        });
      }
      const res = await generateText({
        model: languageModel,
        system,
        messages,
        providerOptions: reasoningProviderOptions(provider, model, 'low'),
      });
      const text = res.text.trim();
      if (!text || text.includes(FIN)) return null;
      return text;
    },
  };
}
