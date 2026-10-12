import { describe, it, expect } from 'vitest';
import { isAdOpener, raiseStage, stageFloor, type StageSignals } from './stage.js';
import type { ConversationMessage } from './types.js';

const lead = (content: string): ConversationMessage =>
  ({ direction: 'inbound', senderType: 'lead', content, sentAt: '2026-10-10T00:00:00Z' }) as ConversationMessage;
const bot = (content: string): ConversationMessage =>
  ({ direction: 'outbound', senderType: 'bot', content, sentAt: '2026-10-10T00:00:01Z' }) as ConversationMessage;

const signals = (o: Partial<StageSignals>): StageSignals => ({
  history: [],
  reply: '',
  openerKeywords: ['PRECIO', 'quiero información'],
  slotsOffered: false,
  askedSomething: false,
  ...o,
});

describe('isAdOpener', () => {
  it('a configured CTA keyword is the ad talking, not the lead', () => {
    expect(isAdOpener('PRECIO', ['PRECIO'])).toBe(true);
    expect(isAdOpener('Hola, quiero información del láser', ['quiero información'])).toBe(true);
  });
  it('a one-tap short message with no question is an opener', () => {
    expect(isAdOpener('hola buenas tardes', [])).toBe(true);
  });
  it('a real sentence or a question is the lead talking', () => {
    expect(isAdOpener('¿cuánto cuesta?', [])).toBe(false);
    expect(isAdOpener('tengo manchas en la cara y quiero saber si el láser me sirve', [])).toBe(false);
  });
});

describe('stageFloor', () => {
  it('the 50-of-59 botox ghost: PRECIO button, bot answered, lead never wrote again → NI', () => {
    const r = stageFloor(signals({ history: [lead('PRECIO'), bot('¡Hola! ¿Es tu primera vez con bótox?')], reply: '' }));
    expect(r.stage).toBe('NI');
  });

  it('the bot gave a price to the opener → I even with no lead engagement', () => {
    const r = stageFloor(signals({ history: [lead('PRECIO')], reply: 'El bótox está en $3,500 por zona.' }));
    expect(r.stage).toBe('I');
    expect(r.reasons).toContain('price_given');
  });

  it('price→slots on turn 1 to a one-tap opener is NOT commitment: slots offered but lead silent → I', () => {
    const r = stageFloor(signals({
      history: [lead('PRECIO')],
      reply: 'Son $500. Tengo mañana 10:00 o 12:00, ¿cuál te queda?',
      slotsOffered: true,
    }));
    expect(r.stage).toBe('I');
  });

  it('the lead answered the bot once, no question → I', () => {
    const r = stageFloor(signals({ history: [lead('PRECIO'), bot('¿Primera vez?'), lead('sí')], reply: 'Perfecto.' }));
    expect(r.stage).toBe('I');
    expect(r.reasons).toContain('lead_messages:1');
  });

  it('the lead asked their own question → A', () => {
    const r = stageFloor(signals({
      history: [lead('PRECIO'), bot('¿Primera vez?'), lead('¿duele? ¿cuánto dura?')],
      reply: 'No duele y dura 4 meses.',
    }));
    expect(r.stage).toBe('A');
    expect(r.reasons).toContain('lead_asked');
  });

  it('an opener that is itself a real question counts as the lead asking → A once engaged', () => {
    const r = stageFloor(signals({ history: [lead('¿el láser sirve para manchas de sol?')], reply: 'Sí.' }));
    expect(r.stage).toBe('A');
  });

  it('lookupFaq / a classified interest counts as asking even without a question mark → A', () => {
    const r = stageFloor(signals({
      history: [lead('PRECIO'), bot('¿Primera vez?'), lead('me interesa el sculptra')],
      reply: 'Claro.',
      askedSomething: true,
    }));
    expect(r.stage).toBe('A');
  });

  it('engaged lead + slots offered → C', () => {
    const r = stageFloor(signals({
      history: [lead('PRECIO'), bot('Son $500'), lead('¿tienes algo el jueves?')],
      reply: 'Jueves 10:00 o 12:00.',
      slotsOffered: true,
    }));
    expect(r.stage).toBe('C');
    expect(r.reasons).toContain('slots_offered');
  });

  it('a lead who opened with a full sentence is engaged from message one', () => {
    const r = stageFloor(signals({
      history: [lead('tengo flacidez en el cuello y quiero una valoración lo antes posible')],
      reply: 'Tengo mañana 10:00.',
      slotsOffered: true,
    }));
    expect(r.stage).toBe('C');
  });
});

describe('raiseStage', () => {
  it('raises', () => expect(raiseStage('I', 'C')).toBe('C'));
  it('never lowers', () => expect(raiseStage('A', 'NI')).toBe('A'));
  it('ignores garbage', () => {
    expect(raiseStage('I', 'hot')).toBe('I');
    expect(raiseStage('I', 7)).toBe('I');
    expect(raiseStage('I', undefined)).toBe('I');
  });
  it('is case-tolerant', () => expect(raiseStage('NI', 'a')).toBe('A'));
});
