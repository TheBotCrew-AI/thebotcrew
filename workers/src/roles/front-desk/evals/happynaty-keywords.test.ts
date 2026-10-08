/**
 * HappyNatyNat ads open the chat with a preset phrase; the phrase decides the campaign variant
 * (first-touch sticky) and is also the entry gate. A phrase that lands on the wrong variant
 * gives a closing-stage lead the awareness pitch, or the reverse, with no event to show for it —
 * so each ad's routing is pinned here, deterministic, in the CI gate.
 */
import { describe, it, expect } from 'vitest';
import { matchVariantKeyword, messageMatchesTrigger } from '../../../core/tenant.js';
import { parseFrontDeskConfig } from '../config.js';
import { buildFrontDeskInstructions } from '../prompt.js';
import { HAPPYNATY_VARIANTS, happyNatyTenant } from './fixtures.js';

/** The phrase each ad pre-fills, verbatim from the ad brief, plus how leads trim or edit it. */
const ADS: { variant: string; messages: string[] }[] = [
  { variant: 'p2b', messages: ['¿Por qué la misma blusa se ve distinta según el color?', 'lo de la misma blusa'] },
  { variant: 'p4', messages: ['¿Qué color de tinte me favorece?', 'Hola! Quiero cambiar de tinte', 'qué tintes me quedan'] },
  { variant: 'p8', messages: ['¿Cómo puedo conocer mis colores?', 'quiero conocer mis colores'] },
  { variant: 'c1', messages: ['Quiero saber mis colores reales, sin filtro', 'colores sin filtro porfa'] },
  { variant: 'c2', messages: ['¿Cuál es mi combinación de colores?', 'mi combinacion'] },
  { variant: 'c3', messages: ['Quiero ver todo lo que incluye la sesión', '¿Qué incluye?', '¿incluye el tinte?'] },
];

describe('HappyNatyNat — ad phrase → variant', () => {
  it.each(ADS.flatMap(({ variant, messages }) => messages.map((m) => ({ variant, m }))))('"$m" → $variant', ({ variant, m }) => {
    expect(matchVariantKeyword(happyNatyTenant, m)?.variant).toBe(variant);
    expect(messageMatchesTrigger(m, happyNatyTenant.triggerKeywords!)).toBe(true);
  });

  it('every keyword points at a variant that exists', () => {
    for (const v of Object.values(happyNatyTenant.keywordVariants!)) expect(Object.keys(HAPPYNATY_VARIANTS)).toContain(v);
  });

  it('a bare greeting or an unrelated DM opens nothing', () => {
    for (const m of ['Hola', 'Buenos días', 'Hola nat, mañana te paso la dirección', '¿Cuál es tu correo?']) {
      expect(messageMatchesTrigger(m, happyNatyTenant.triggerKeywords!)).toBe(false);
      expect(matchVariantKeyword(happyNatyTenant, m)).toBeNull();
    }
  });
});

describe('HappyNatyNat — the prompt each variant renders', () => {
  const config = parseFrontDeskConfig(happyNatyTenant.config);
  const render = (variant?: string) =>
    buildFrontDeskInstructions(config, new Date().toISOString(), '+526641234567', undefined, undefined, undefined, variant);

  it.each(Object.keys(HAPPYNATY_VARIANTS))('%s keeps the house rules and the common flow', (variant) => {
    const prompt = render(variant);
    expect(prompt).toContain('# Hablar de imagen es delicado');
    expect(prompt).toContain('# Objeciones');
    expect(prompt).toContain('# Tu primer mensaje (anuncio:');
  });

  it('the session is never booked: the only bookable service is the call', () => {
    expect(Object.keys(config.calendars)).toEqual(['Llamada de diagnóstico']);
    expect(render('c1')).toContain('La sesión no se agenda por aquí');
  });
});
