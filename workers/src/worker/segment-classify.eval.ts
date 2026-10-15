/**
 * Live eval — the status classifier's zone / objection picks (0073), on Heriberto's
 * catalogs. Measures the one thing the unit tests can't: whether the model, given the
 * slug list with hints, names what the lead SAID and nothing more.
 *
 * Runs only with a provider key (`pnpm eval`); self-skips otherwise. Pass rates are a
 * rate, not a switch — measured 2026-10-14 on gpt-6-luna, 3 runs: 18/18 (every case
 * 3/3, 0.8–2.8 s per call).
 */

import { describe, it, expect } from 'vitest';
import { classifyConversationOutcome } from './webhook-handler.js';
import type { AuxLlmCall } from './aux-llm.js';
import { evalApiKey, evalModel, evalProvider } from '../roles/front-desk/evals/eval-model.js';
import { parseCatalog } from '../core/lead-memory.js';

const live = !!evalApiKey;

const llm: AuxLlmCall = {
  clientId: 'eval',
  ghlConversationId: 'eval-segment-classify',
  provider: evalProvider,
  apiKey: evalApiKey,
  model: evalModel,
  keySource: 'platform',
};

const SERVICES = ['Botox', 'Ácido Hialurónico', 'Láser CO₂ Fraccionado', 'Sculptra'];
const ZONES = parseCatalog([
  { slug: 'frente', label: 'frente', hints: ['líneas de la frente'] },
  { slug: 'entrecejo', label: 'entrecejo', hints: ['el 11', 'ceño fruncido'] },
  { slug: 'patas-de-gallo', label: 'patas de gallo', hints: ['líneas al lado de los ojos'] },
  { slug: 'labios', label: 'labios', hints: ['boca', 'volumen de labios'] },
  { slug: 'ojeras', label: 'ojeras', hints: ['bolsas', 'ojos cansados'] },
  { slug: 'surco-nasogeniano', label: 'surco nasogeniano', hints: ['líneas de la nariz a la boca', 'paréntesis'] },
  { slug: 'manchas', label: 'manchas', hints: ['paño', 'melasma'] },
  { slug: 'flacidez', label: 'flacidez', hints: ['piel caída', 'falta de firmeza'] },
]);
const OBJECTIONS = parseCatalog([
  { slug: 'precio', label: 'precio', hints: ['está caro', 'no me alcanza'] },
  { slug: 'miedo-dolor', label: 'miedo al dolor', hints: ['duele', 'agujas'] },
  { slug: 'miedo-resultado', label: 'miedo al resultado', hints: ['se nota', 'cara congelada'] },
  { slug: 'tiempo', label: 'tiempo', hints: ['no tengo tiempo', 'ando ocupada'] },
  { slug: 'lo-pensara', label: 'lo pensará', hints: ['lo pienso', 'después te digo'] },
  { slug: 'pareja-familia', label: 'pareja o familia', hints: ['le pregunto a mi esposo'] },
]);
const segments = { zones: ZONES, objections: OBJECTIONS };

const classify = (lead: string, bot = '¿Te gustaría agendar tu valoración?') =>
  classifyConversationOutcome(lead, bot, llm, SERVICES, false, segments);

describe.skipIf(!live)('segment classifier — zones and objections from the catalog', () => {
  it('names the zones the lead said, by slug, through a hint ("el 11" → entrecejo)', async () => {
    const r = await classify('Hola, me interesa el botox, me molesta mucho la frente y el 11');
    expect(r.interest).toBe('Botox');
    expect(r.zones).toEqual(expect.arrayContaining(['frente', 'entrecejo']));
    expect(r.zones).toHaveLength(2);
    expect(r.objection).toBeNull();
  }, 30_000);

  it('a vague wish is not a zone: "quiero verme mejor" → []', async () => {
    const r = await classify('Quiero verme mejor, qué me recomiendas?');
    expect(r.zones).toEqual([]);
    expect(r.objection).toBeNull();
  }, 30_000);

  it('a reason not to book this turn → one objection slug', async () => {
    const r = await classify('Uy está muy caro, no me alcanza ahorita', 'Claro, cuando gustes te agendo.');
    expect(r.objection).toBe('precio');
  }, 30_000);

  it('fear of pain through a hint', async () => {
    const r = await classify('Es que me da mucho miedo que duela, las agujas no son lo mío');
    expect(r.objection).toBe('miedo-dolor');
    expect(r.zones).toEqual([]);
  }, 30_000);

  it('a concern outside the catalog → otro (never a made-up slug)', async () => {
    const r = await classify('Lo que me preocupa es la papada, se me ve mucho');
    expect(r.zones).toEqual(['otro']);
  }, 30_000);

  it('a plain yes carries no zone and no objection', async () => {
    const r = await classify('Sí, me gustaría agendar');
    expect(r.zones).toEqual([]);
    expect(r.objection).toBeNull();
  }, 30_000);
});
