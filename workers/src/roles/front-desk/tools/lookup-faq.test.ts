import { describe, it, expect } from 'vitest';
import { lookupFaqTool } from './lookup-faq.js';

const ctxWith = (faq: { q: string; a: string }[], activeRole?: string) => {
  const tenant = { config: { businessName: 'X', timezone: 'America/Mexico_City', faq } };
  const turn = { ghlContactId: 'c1', ghlConversationId: 'conv1', activeRole };
  return { requestContext: { get: (k: string) => (k === 'tenant' ? tenant : k === 'turn' ? turn : undefined) } };
};
const run = (question: string, faq: { q: string; a: string }[], activeRole?: string) =>
  (lookupFaqTool.execute as (i: { question: string }, c: ReturnType<typeof ctxWith>) => Promise<{ matches: { q: string; a: string }[] }>)({ question }, ctxWith(faq, activeRole));

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

  // In demo the agent roleplays ANOTHER business; this FAQ holds ours. The prompt stops
  // announcing the tool, but it stays registered, so the guard has to live in the tool.
  describe('demo mode', () => {
    it('returns nothing even on a direct hit', async () => {
      expect(await run('¿cuánto cuesta un corte?', FAQ, 'demo')).toEqual({ matches: [] });
    });

    // The dangerous branch: with no token overlap the tool dumps the ENTIRE FAQ, which
    // would drop our own pricing and offer into the middle of someone else's roleplay.
    it('returns nothing on the no-overlap branch, instead of the whole FAQ', async () => {
      expect(await run('xyzzy plugh', FAQ, 'demo')).toEqual({ matches: [] });
    });

    it('still answers normally for the closer, once the roleplay is over', async () => {
      const { matches } = await run('¿aceptan tarjeta?', FAQ, 'closer');
      expect(matches[0]!.q).toBe('¿Aceptan tarjeta?');
    });
  });
});
