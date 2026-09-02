import { describe, it, expect } from 'vitest';
import { HUMAN_REPLY_PREFIX, PHOTO_DESCRIPTION_PREFIX, hasHumanReplies, photoDescriptionLine, toModelMessages } from './model-messages.js';
import type { ConversationMessage } from './types.js';

const msg = (senderType: ConversationMessage['senderType'], content: string): ConversationMessage => ({
  direction: senderType === 'lead' ? 'inbound' : 'outbound',
  senderType,
  content,
  sentAt: '2026-08-26T23:10:00Z',
});

describe('toModelMessages', () => {
  it('lead → user, bot → assistant, verbatim', () => {
    expect(toModelMessages([msg('lead', 'hola'), msg('bot', '¡Hola!')])).toEqual([
      { role: 'user', content: 'hola' },
      { role: 'assistant', content: '¡Hola!' },
    ]);
  });

  it("a human teammate's reply is an assistant message marked as the team's, not the bot's", () => {
    const [human] = toModelMessages([msg('human_agent', 'Sí se puede con 17 años, acompañada de un adulto.')]);
    expect(human).toEqual({
      role: 'assistant',
      content: `${HUMAN_REPLY_PREFIX} Sí se puede con 17 años, acompañada de un adulto.`,
    });
  });

  it('never marks a bot message', () => {
    const [bot] = toModelMessages([msg('bot', 'Déjame lo confirmo con el equipo.')]);
    expect(bot?.content).not.toContain(HUMAN_REPLY_PREFIX);
  });

  it('keeps order', () => {
    const out = toModelMessages([msg('lead', 'a'), msg('bot', 'b'), msg('human_agent', 'c'), msg('lead', 'd')]);
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant', 'assistant', 'user']);
  });
});

describe('hasHumanReplies', () => {
  it('true only when a human_agent message is in the window', () => {
    expect(hasHumanReplies([msg('lead', 'a'), msg('bot', 'b')])).toBe(false);
    expect(hasHumanReplies([msg('lead', 'a'), msg('human_agent', 'b')])).toBe(true);
    expect(hasHumanReplies([])).toBe(false);
  });
});

describe('photoDescriptionLine', () => {
  it('wraps the description in the marker the prompt teaches', () => {
    expect(photoDescriptionLine('  parte baja del rostro  ')).toBe(`${PHOTO_DESCRIPTION_PREFIX} parte baja del rostro]`);
  });
  it("keeps the lead's caption first, as their own words", () => {
    expect(photoDescriptionLine('surcos', 'esta zona')).toBe(`esta zona\n${PHOTO_DESCRIPTION_PREFIX} surcos]`);
    expect(photoDescriptionLine('surcos', '   ')).toBe(`${PHOTO_DESCRIPTION_PREFIX} surcos]`);
  });
});
