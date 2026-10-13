import { describe, it, expect } from 'vitest';
import { channelDelivers, pickAsset, type MediaAsset } from './media-assets.js';

const assets: MediaAsset[] = [
  { slot: 'precios', kind: 'image', url: 'https://x/precios.png', name: 'precios.png', interest: null },
  { slot: 'precios', kind: 'document', url: 'https://x/botox.pdf', name: 'botox.pdf', interest: 'Botox' },
  { slot: 'que-esperar', kind: 'document', url: 'https://x/laser.pdf', name: 'laser.pdf', interest: 'Láser CO₂ Fraccionado' },
];

describe('channelDelivers', () => {
  it('instagram carries images only; whatsapp and facebook carry both', () => {
    expect(channelDelivers('instagram', 'image')).toBe(true);
    expect(channelDelivers('instagram', 'document')).toBe(false);
    expect(channelDelivers('whatsapp', 'document')).toBe(true);
    expect(channelDelivers('facebook', 'document')).toBe(true);
  });
});

describe('pickAsset', () => {
  it('the treatment row wins over the generic one', () => {
    expect(pickAsset(assets, 'precios', 'Botox', 'whatsapp')?.url).toBe('https://x/botox.pdf');
  });

  it('no treatment match → the generic row', () => {
    expect(pickAsset(assets, 'precios', 'Sculptra', 'whatsapp')?.url).toBe('https://x/precios.png');
    expect(pickAsset(assets, 'precios', null, 'whatsapp')?.url).toBe('https://x/precios.png');
  });

  it('a file the channel cannot carry is skipped, falling to the generic row — or to nothing', () => {
    // Botox PDF on Instagram → the generic image instead.
    expect(pickAsset(assets, 'precios', 'Botox', 'instagram')?.url).toBe('https://x/precios.png');
    // The laser PDF has no generic sibling → nothing (the runner then offers text angles).
    expect(pickAsset(assets, 'que-esperar', 'Láser CO₂ Fraccionado', 'instagram')).toBeNull();
  });

  it('interest and slot match accent- and case-tolerantly; a treatment-only slot yields nothing for another treatment', () => {
    expect(pickAsset(assets, 'Que-Esperar', 'laser co2 fraccionado', 'whatsapp')?.url).toBe('https://x/laser.pdf');
    expect(pickAsset(assets, 'que-esperar', 'Botox', 'whatsapp')).toBeNull();
    expect(pickAsset(assets, 'consultorio', 'Botox', 'whatsapp')).toBeNull();
  });
});
