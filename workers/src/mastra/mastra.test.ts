/**
 * Smoke test: the Mastra instance constructs (agents + GHL route + deployer)
 * and the front-desk agent is registered. Catches wiring/import regressions.
 */

import { describe, it, expect } from 'vitest';
import { mastra } from './index.js';

describe('mastra instance', () => {
  it('constructs and exposes the front-desk agent', () => {
    expect(mastra.getAgent('frontDesk')).toBeTruthy();
  });
});
