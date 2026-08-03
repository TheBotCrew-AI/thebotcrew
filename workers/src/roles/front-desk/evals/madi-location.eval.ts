/**
 * Location eval cases — MADI Skin Care.
 *
 * The clinic's address now carries a Google Maps short link, and a URL is the one
 * kind of fact a model can destroy while looking correct: shortened, re-typed with
 * a wrong character, "described" ("te paso el mapa" with no link), or replaced by a
 * plausible invention. A mangled goo.gl id 404s — worse than no link at all, because
 * the lead assumes the clinic is gone. So the assertion is byte-exact, not fuzzy.
 *
 * Both paths are covered on purpose: the link lives in `offering` (rendered in the
 * prompt) AND in the FAQ (reached through lookupFaq, which the prompt tells the model
 * to adapt rather than paste — exactly where a link gets rewritten).
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

const MAP_URL = 'https://maps.app.goo.gl/kGdvv5yfLLVWtHNr9';

const turn: TurnContext = {
  ghlConversationId: 'conv_eval_madi_location',
  ghlContactId: 'contact_eval_madi_location',
  channel: 'whatsapp',
};

const rc = () =>
  buildAgentRequestContext({ tenant: madiTenant, turn, provider: evalProvider, model: evalModel, llmApiKey: evalApiKey });

// NOT lowercased: the goo.gl id is case-sensitive, so the whole point is the exact string.
const reply = (res: { text: string }) => res.text.trim();

beforeEach(() => vi.clearAllMocks());

describe.skipIf(!evalApiKey)('MADI — the location comes with the map link, intact', () => {
  it('shares the exact Maps URL when asked where the clinic is', async () => {
    const agent = buildFrontDeskAgent();
    const res = await agent.generate(
      [{ role: 'user', content: 'Hola, ¿dónde están ubicados?' }],
      { requestContext: rc() },
    );

    expect(reply(res)).toContain('Plaza Financiera');
    expect(reply(res)).toContain(MAP_URL);
  });

  it('shares it when she asks how to get there mid-conversation', async () => {
    const agent = buildFrontDeskAgent();
    const res = await agent.generate(
      [
        { role: 'assistant', content: '¡Hola! Soy Majo, de MADI Skin Care 😊 ¿Cómo te puedo apoyar hoy?' },
        { role: 'user', content: 'Quiero ir mañana, ¿cómo llego? ¿me pasas la ubicación?' },
      ],
      { requestContext: rc() },
    );

    expect(reply(res)).toContain(MAP_URL);
  });

  it('does not invent a different address or a second link', async () => {
    const agent = buildFrontDeskAgent();
    const res = await agent.generate(
      [{ role: 'user', content: '¿Cuál es la dirección exacta? ¿Tienen sucursal en Otay?' }],
      { requestContext: rc() },
    );

    const text = reply(res);
    // Any link it prints must be THE link — no invented goo.gl / maps.google URLs.
    const urls = text.match(/https?:\/\/\S+/g) ?? [];
    for (const url of urls) expect(url.replace(/[).,]+$/, '')).toBe(MAP_URL);
    // Naming Otay is fine — DENYING the branch is the correct answer. Two earlier
    // versions of this case went red on good answers ("No contamos con sucursal en
    // Otay", "No tengo registro de sucursal en Otay, lo confirmo con el equipo"),
    // because they graded the wording. Grade the property instead: whatever sentence
    // mentions Otay must deny it or defer it — never affirm it.
    const otaySentence = text.split(/[.;\n]/).find((s) => /otay/i.test(s));
    if (otaySentence) {
      expect(otaySentence).toMatch(/\bno\b|\bsin\b|únic|sol[oa]|confirm|registro|equipo/i);
    }
  });
});
