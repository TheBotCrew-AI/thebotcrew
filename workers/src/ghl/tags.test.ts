import { describe, it, expect } from 'vitest';
import { BOT_OFF_TAG, STATUS_TAGS } from './tags.js';

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
