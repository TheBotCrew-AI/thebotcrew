import { describe, it, expect } from 'vitest';
import { buildFrontDeskAgent, DEFAULT_PROVIDER, DEFAULT_MODEL, FRONT_DESK_ROLE } from './agent.js';

describe('buildFrontDeskAgent', () => {
  it('constructs a fresh agent (lazy instructions/model — no env needed at build time)', () => {
    const agent = buildFrontDeskAgent();
    expect(agent).toBeTruthy();
    expect(buildFrontDeskAgent()).not.toBe(agent); // a new instance each call
  });

  it('exposes the platform defaults + role id', () => {
    expect(FRONT_DESK_ROLE).toBe('front-desk');
    expect(DEFAULT_PROVIDER).toBe('openai');
    expect(DEFAULT_MODEL).toBe('gpt-5-mini');
  });
});
