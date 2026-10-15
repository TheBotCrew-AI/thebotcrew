import { describe, it, expect } from 'vitest';
import { parseCatalog } from './lead-memory.js';
import { matchCatalog, matchZones, segmentPromptAddendum, OTHER_SLUG } from './segments.js';

const ZONES = parseCatalog([
  { slug: 'frente', label: 'frente', hints: ['líneas de la frente'] },
  { slug: 'patas-de-gallo', label: 'patas de gallo', hints: [] },
  { slug: 'surco-nasogeniano', label: 'surco nasogeniano', hints: ['paréntesis', 'líneas de la nariz a la boca'] },
]);
const OBJECTIONS = parseCatalog([
  { slug: 'precio', label: 'precio', hints: ['está caro'] },
  { slug: 'miedo-dolor', label: 'miedo al dolor', hints: [] },
]);

describe('matchCatalog — a closed list with one escape hatch', () => {
  it('returns the catalog slug for a slug or label match, case/accent-insensitive', () => {
    expect(matchCatalog(ZONES, 'frente')).toBe('frente');
    expect(matchCatalog(ZONES, 'Patas De Gallo')).toBe('patas-de-gallo');
    expect(matchCatalog(OBJECTIONS, 'Miedo al dolor')).toBe('miedo-dolor');
  });

  it('a real value the catalog lacks becomes otro — for the weekly review, never a new tag', () => {
    expect(matchCatalog(ZONES, 'papada')).toBe(OTHER_SLUG);
    expect(matchCatalog(ZONES, 'otro')).toBe(OTHER_SLUG);
    expect(matchCatalog(OBJECTIONS, 'no confío en clínicas')).toBe(OTHER_SLUG);
  });

  it('empty / non-string → null (nothing to tag)', () => {
    expect(matchCatalog(ZONES, null)).toBeNull();
    expect(matchCatalog(ZONES, '')).toBeNull();
    expect(matchCatalog(ZONES, 3)).toBeNull();
  });
});

describe('matchZones', () => {
  it('validates each entry, dedupes, caps at three', () => {
    expect(matchZones(ZONES, ['frente', 'Frente', 'papada', 'patas-de-gallo', 'surco-nasogeniano'])).toEqual([
      'frente', OTHER_SLUG, 'patas-de-gallo',
    ]);
    expect(matchZones(ZONES, 'frente')).toEqual([]);
    expect(matchZones(ZONES, [null, '', 'frente'])).toEqual(['frente']);
  });
});

describe('segmentPromptAddendum — built from the catalogs, not hardcoded', () => {
  it('lists services, zone slugs with their hints, objection slugs, and the four-field JSON', () => {
    const out = segmentPromptAddendum(['Botox', 'Sculptra'], ZONES, OBJECTIONS);
    expect(out).toContain('- Botox');
    expect(out).toContain('- surco-nasogeniano (paréntesis, líneas de la nariz a la boca)');
    expect(out).toContain('- patas-de-gallo\n');
    expect(out).toContain('- precio (está caro)');
    expect(out).toContain('"zones":[...]');
    expect(out).toContain('"objection"');
    expect(out).toContain(`"${OTHER_SLUG}"`);
  });

  it('a slug added to the catalog shows up — no redeploy', () => {
    const more = parseCatalog([...ZONES, { slug: 'papada', label: 'papada', hints: ['doble mentón'] }]);
    expect(segmentPromptAddendum(['Botox'], more, OBJECTIONS)).toContain('- papada (doble mentón)');
  });
});
