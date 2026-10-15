import { describe, it, expect } from 'vitest';
import { isPatientOf, leadMemoryLine, parseCatalog, readLeadMemory } from './lead-memory.js';

const SERVICES = [
  { name: 'Botox' },
  { name: 'Ácido Hialurónico' },
  { name: 'Láser CO₂ Fraccionado', tagSlug: 'laser-co2' },
];
const ZONES = parseCatalog([
  { slug: 'labios', label: 'labios', hints: [] },
  { slug: 'ojeras', label: 'ojeras', hints: ['bolsas'] },
  { slug: 'surco-nasogeniano', label: 'surco nasogeniano', hints: [] },
]);

describe('parseCatalog', () => {
  it('keeps well-formed entries, defaults the label to the slug, drops junk', () => {
    expect(parseCatalog([{ slug: 'frente' }, { label: 'sin slug' }, 'x', null, { slug: ' ', label: 'y' }])).toEqual([
      { slug: 'frente', label: 'frente', hints: [] },
    ]);
    expect(parseCatalog(null)).toEqual([]);
  });
});

describe('readLeadMemory — the funnel tags the client writes, read back as facts', () => {
  it('maps paciente:/cotizo: slugs to the configured service names, including a tagSlug', () => {
    const m = readLeadMemory(['paciente:botox', 'cotizo:laser-co2', 'fuente:instagram'], SERVICES, ZONES);
    expect(m.patientOf).toEqual(['Botox']);
    expect(m.quoted).toEqual(['Láser CO₂ Fraccionado']);
    expect(m.zones).toEqual([]);
    expect(m.evaluated).toBe(false);
  });

  it('keeps an unknown slug as-is rather than dropping the fact', () => {
    expect(readLeadMemory(['paciente:hilos'], SERVICES, ZONES).patientOf).toEqual(['hilos']);
  });

  it('renders zones through the catalog label and reads valorado / noshow:', () => {
    const m = readLeadMemory(['zona:surco-nasogeniano', 'zona:otro', 'valorado', 'noshow:botox'], SERVICES, ZONES);
    expect(m.zones).toEqual(['surco nasogeniano', 'otro']);
    expect(m.evaluated).toBe(true);
    expect(m.noShows).toEqual(['botox']);
  });

  it('no tags → empty memory, no line', () => {
    expect(leadMemoryLine(readLeadMemory(undefined, SERVICES, ZONES))).toBe('');
    expect(leadMemoryLine(readLeadMemory(['bot-standby', 'interes:botox'], SERVICES, ZONES))).toBe('');
  });
});

describe('leadMemoryLine', () => {
  it('writes the one sentence the prompt gets', () => {
    const m = readLeadMemory(
      ['paciente:botox', 'cotizo:acido-hialuronico', 'zona:labios', 'zona:ojeras'],
      SERVICES,
      ZONES,
    );
    expect(leadMemoryLine(m)).toBe(
      'Este contacto: ya es paciente de Botox; se le cotizó Ácido Hialurónico; le preocupan labios y ojeras.',
    );
  });

  it('singular agreement for one zone', () => {
    expect(leadMemoryLine(readLeadMemory(['zona:labios'], SERVICES, ZONES))).toBe('Este contacto: le preocupa labios.');
  });
});

describe('isPatientOf — the guard that stops re-tagging interest on a patient', () => {
  it('matches by the service slug, honouring tagSlug', () => {
    expect(isPatientOf(['paciente:botox'], SERVICES[0]!)).toBe(true);
    expect(isPatientOf(['paciente:laser-co2'], SERVICES[2]!)).toBe(true);
    expect(isPatientOf(['paciente:laser-co2-fraccionado'], SERVICES[2]!)).toBe(false);
    expect(isPatientOf(['interes:botox'], SERVICES[0]!)).toBe(false);
  });
});
