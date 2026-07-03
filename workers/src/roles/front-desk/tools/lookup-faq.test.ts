import { describe, it, expect } from 'vitest';
import { lookupFaqTool } from './lookup-faq.js';

const ctxWith = (faq: { q: string; a: string }[]) => {
  const tenant = { config: { businessName: 'X', timezone: 'America/Mexico_City', faq } };
  const turn = { ghlContactId: 'c1', ghlConversationId: 'conv1' };
  return { requestContext: { get: (k: string) => (k === 'tenant' ? tenant : k === 'turn' ? turn : undefined) } };
};
const run = (question: string, faq: { q: string; a: string }[]) =>
  (lookupFaqTool.execute as (i: { question: string }, c: ReturnType<typeof ctxWith>) => Promise<{ matches: { q: string; a: string }[] }>)({ question }, ctxWith(faq));

const FAQ = [
  { q: '¿Cuánto cuesta el corte de cabello?', a: 'Cuesta 500 pesos.' },
  { q: '¿Dónde están ubicados?', a: 'En el centro.' },
  { q: '¿Aceptan tarjeta?', a: 'Sí, aceptamos tarjeta.' },
];

describe('lookupFaq tool', () => {
  it('empty FAQ → no matches', async () => {
    expect(await run('cualquier cosa', [])).toEqual({ matches: [] });
  });

  it('ranks the best token overlap first', async () => {
    const { matches } = await run('¿cuánto cuesta un corte?', FAQ);
    expect(matches[0]!.q).toBe('¿Cuánto cuesta el corte de cabello?');
  });

  it('is accent-insensitive', async () => {
    const { matches } = await run('donde estan ubicados', FAQ);
    expect(matches[0]!.q).toBe('¿Dónde están ubicados?');
  });

  it('no overlap → returns the whole FAQ so the agent still grounds its answer', async () => {
    const { matches } = await run('xyzzy plugh', FAQ);
    expect(matches).toHaveLength(FAQ.length);
  });
});
