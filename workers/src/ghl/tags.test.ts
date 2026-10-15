import { describe, it, expect } from 'vitest';
import { BOT_OFF_TAG, STATUS_TAGS, INTEREST_TAG_PREFIX, NO_PROMOS_TAG, interestTag, tagSlug } from './tags.js';

describe('GHL tag mapping', () => {
  it('bot-off is the kill-switch tag', () => {
    expect(BOT_OFF_TAG).toBe('bot-off');
  });

  it('handed_off mirrors to the bot-off tag (keeps the bot suppressed in GHL)', () => {
    expect(STATUS_TAGS.handed_off).toBe(BOT_OFF_TAG);
  });

  it('maps the other terminal statuses to their own tags', () => {
    expect(STATUS_TAGS.completed).toBe('bot-completed');
    expect(STATUS_TAGS.opted_out).toBe('bot-opted-out');
    expect(STATUS_TAGS.standby).toBe('bot-standby');
  });

  it('has no tag for the active status', () => {
    expect(STATUS_TAGS.active).toBeUndefined();
  });

  it('no-promos is its own tag, not a status mirror', () => {
    expect(NO_PROMOS_TAG).toBe('no-promos');
    expect(Object.values(STATUS_TAGS)).not.toContain(NO_PROMOS_TAG);
  });
});

describe('interestTag (0058, prefix:value since 0073)', () => {
  it('slugs a service name after the colon: lowercase, no accents, dashes', () => {
    expect(INTEREST_TAG_PREFIX).toBe('interes:');
    expect(interestTag('Botox')).toBe('interes:botox');
    expect(interestTag('Ácido Hialurónico')).toBe('interes:acido-hialuronico');
    expect(interestTag('Consulta de Bariatría')).toBe('interes:consulta-de-bariatria');
    expect(interestTag('PDRN Salmón')).toBe('interes:pdrn-salmon');
  });

  it('maps the subscript ₂ in "CO₂" to a plain 2 instead of dropping it', () => {
    expect(interestTag('Láser CO₂ Fraccionado')).toBe('interes:laser-co2-fraccionado');
  });

  it('a configured tagSlug wins over the name — it must match the tag GHL already has', () => {
    expect(interestTag('Láser CO₂ Fraccionado', 'laser-co2')).toBe('interes:laser-co2');
    // The override is slugged too, so an operator typo in casing or accents can't fork the tag.
    expect(interestTag('Láser CO₂ Fraccionado', ' Laser-CO2 ')).toBe('interes:laser-co2');
    expect(interestTag('Botox', '')).toBe('interes:botox');
  });

  it('collapses punctuation runs and trims edge dashes', () => {
    expect(interestTag('  Skinvive (skinbooster) — 2ml ')).toBe('interes:skinvive-skinbooster-2ml');
    expect(tagSlug('Patas de gallo')).toBe('patas-de-gallo');
  });
});
