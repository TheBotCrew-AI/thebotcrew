import { describe, it, expect } from 'vitest';
import { BOT_OFF_TAG, STATUS_TAGS, INTEREST_TAG_PREFIX, interestTag } from './tags.js';

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
});

describe('interestTag (0058)', () => {
  it('slugs a service name: lowercase, no accents, dashes', () => {
    expect(interestTag('Botox')).toBe('interes-botox');
    expect(interestTag('Ácido Hialurónico')).toBe('interes-acido-hialuronico');
    expect(interestTag('Consulta de Bariatría')).toBe('interes-consulta-de-bariatria');
    expect(interestTag('PDRN Salmón')).toBe('interes-pdrn-salmon');
  });

  it('maps the subscript ₂ in "CO₂" to a plain 2 instead of dropping it', () => {
    expect(interestTag('Láser CO₂ Fraccionado')).toBe('interes-laser-co2-fraccionado');
  });

  it('collapses punctuation runs and trims edge dashes', () => {
    expect(interestTag('  Skinvive (skinbooster) — 2ml ')).toBe('interes-skinvive-skinbooster-2ml');
    expect(interestTag('Botox')).toMatch(new RegExp(`^${INTEREST_TAG_PREFIX}`));
  });
});
