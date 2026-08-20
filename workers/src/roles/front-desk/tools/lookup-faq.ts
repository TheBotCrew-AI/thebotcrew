/**
 * lookupFaq — answer frequent questions strictly from the tenant's configured FAQ.
 * No external call; this is the anti-hallucination path for common questions.
 */

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { resolveAgentContext } from './agent-context.js';

const STOPWORDS = new Set([
  'el', 'la', 'los', 'las', 'un', 'una', 'de', 'del', 'que', 'como', 'donde',
  'cuando', 'cuanto', 'cual', 'y', 'o', 'a', 'en', 'es', 'son', 'me', 'mi',
]);

function tokens(text: string): string[] {
  // NFD + stripping non-ascii also removes accents' combining marks.
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

export const lookupFaqTool = createTool({
  id: 'lookupFaq',
  description:
    'Busca respuestas en las preguntas frecuentes (FAQ) configuradas del negocio. ' +
    'Úsala antes de responder dudas generales del cliente.',
  inputSchema: z.object({
    question: z.string().describe('La pregunta o tema del cliente'),
  }),
  outputSchema: z.object({
    matches: z.array(z.object({ q: z.string(), a: z.string() })),
  }),
  execute: async ({ question }, ctx) => {
    const { config, turn } = resolveAgentContext(ctx);

    // Demo mode: the agent is roleplaying ANOTHER business and this FAQ holds OURS. The
    // prompt stops announcing the tool while a demo is active, but it stays registered with
    // a generic description, so the model can still reach for it — and the no-overlap branch
    // below returns the WHOLE FAQ, which would drop our own offer and pricing into the middle
    // of someone else's roleplay. In demo the answers come from the persona, not from here.
    if (turn.activeRole === 'demo') return { matches: [] };

    if (config.faq.length === 0) return { matches: [] };

    const qTokens = new Set(tokens(question));
    const scored = config.faq
      .map((f) => {
        const fTokens = tokens(`${f.q} ${f.a}`);
        const score = fTokens.filter((t) => qTokens.has(t)).length;
        return { f, score };
      })
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score);

    // Return the best matches, or the whole FAQ if nothing overlaps so the
    // agent can still ground its answer in real configured facts.
    const matches = scored.length > 0 ? scored.slice(0, 3).map((s) => s.f) : config.faq;
    return { matches };
  },
});
