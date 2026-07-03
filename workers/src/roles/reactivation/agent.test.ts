import { describe, it, expect } from 'vitest';
import { buildReactivationAgent, REACTIVATION_ROLE } from './agent.js';

describe('buildReactivationAgent', () => {
  it('constructs a fresh, tool-less agent', () => {
    const agent = buildReactivationAgent();
    expect(agent).toBeTruthy();
    expect(buildReactivationAgent()).not.toBe(agent);
  });

  it('exposes its role id', () => {
    expect(REACTIVATION_ROLE).toBe('reactivation');
  });
});
