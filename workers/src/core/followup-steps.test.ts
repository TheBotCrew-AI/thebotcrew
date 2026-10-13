import { describe, it, expect } from 'vitest';
import { coveredMarks, nextStep, parseStep, type StepSpec } from './followup-steps.js';
import type { MediaAsset } from './media-assets.js';

const seq: StepSpec[] = [
  { covers: 'precio', asset: 'precios', text: 'precio' },
  { covers: 'quien', asset: 'consultorio', text: 'quién' },
  { covers: 'prueba', asset: 'antes-despues', text: 'prueba' },
  { covers: 'oferta', text: 'oferta' },
  { covers: 'cierre', text: 'cierre' },
];
const precios: MediaAsset = { slot: 'precios', kind: 'image', url: 'https://x/p.png', name: 'p.png', interest: null };
const ad: MediaAsset = { slot: 'antes-despues', kind: 'image', url: 'https://x/ad.png', name: 'ad.png', interest: null };
const pick = (covered: string[] = [], assets: MediaAsset[] = [], sentUrls: string[] = [], channel: 'whatsapp' | 'instagram' = 'whatsapp') =>
  nextStep(seq, { covered: new Set(covered as never[]), sentUrls: new Set(sentUrls), assets, interest: null, channel });

describe('parseStep', () => {
  it('accepts the catalogue, case-tolerant; rejects unknown marks, empty text, strings', () => {
    expect(parseStep({ covers: 'Que-Esperar', text: ' t ', asset: 'que-esperar' })).toEqual({ covers: 'que-esperar', text: 't', asset: 'que-esperar' });
    expect(parseStep({ covers: 'horarios', text: 't' })).toBeNull();
    expect(parseStep({ covers: 'precio', text: '' })).toBeNull();
    expect(parseStep('precio')).toBeNull();
  });
});

describe('coveredMarks', () => {
  it('precio from a bot message that states a price; the rest from sent steps; cierre never', () => {
    expect([...coveredMarks(['Hola', 'La frente son $2,500'], [])]).toEqual(['precio']);
    expect([...coveredMarks([], ['quien', 'cierre', 'garbage'])]).toEqual(['quien']);
    expect(coveredMarks(['sin precio'], []).size).toBe(0);
  });
});

describe('nextStep', () => {
  it('a fresh thread → step 1, with its file when the tenant has it', () => {
    expect(pick([], [precios])).toMatchObject({ index: 0, file: precios });
  });
  it('a missing file demotes the step to text (quien without consultorio still goes)', () => {
    expect(pick(['precio'])).toMatchObject({ index: 1, file: null });
  });
  it('prueba without its file is skipped, not texted', () => {
    expect(pick(['precio', 'quien'])).toMatchObject({ index: 3, step: { covers: 'oferta' } });
    expect(pick(['precio', 'quien'], [ad])).toMatchObject({ index: 2, file: ad });
  });
  it('a file the thread already received skips the step even when its mark is not stamped', () => {
    expect(pick([], [precios], ['https://x/p.png'])).toMatchObject({ index: 1 });
  });
  it('the channel filter applies: a document on Instagram is not a file', () => {
    const doc: MediaAsset = { ...ad, kind: 'document' };
    expect(pick(['precio', 'quien'], [doc], [], 'instagram')).toMatchObject({ step: { covers: 'oferta' } });
  });
  it('cierre is never covered; every other mark covered → cierre; a sequence without cierre → null', () => {
    expect(pick(['precio', 'quien', 'prueba', 'oferta'])).toMatchObject({ step: { covers: 'cierre' } });
    expect(nextStep(seq.slice(0, 4), { covered: new Set(['precio', 'quien', 'prueba', 'oferta']), sentUrls: new Set(), assets: [], interest: null, channel: 'whatsapp' })).toBeNull();
  });
});
