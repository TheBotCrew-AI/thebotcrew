import { describe, it, expect } from 'vitest';
import { buildFrontDeskAgent, DEFAULT_PROVIDER, DEFAULT_MODEL, FRONT_DESK_ROLE } from './agent.js';
import { RequestContext } from '@mastra/core/request-context';

/** Only the two values the effort rules read — the rest of the turn context is irrelevant here. */
const defaultOptionsFor = (model: string, provider = 'openai') => {
  const requestContext = new RequestContext();
  requestContext.set('provider', provider);
  requestContext.set('model', model);
  return buildFrontDeskAgent().getDefaultOptions({ requestContext });
};

describe('buildFrontDeskAgent', () => {
  it('constructs a fresh agent (lazy instructions/model — no env needed at build time)', () => {
    const agent = buildFrontDeskAgent();
    expect(agent).toBeTruthy();
    expect(buildFrontDeskAgent()).not.toBe(agent); // a new instance each call
  });

  it('exposes the platform defaults + role id', () => {
    expect(FRONT_DESK_ROLE).toBe('front-desk');
    expect(DEFAULT_PROVIDER).toBe('openai');
    expect(DEFAULT_MODEL).toBe('gpt-5.6-luna');
  });

  // Set on the agent rather than at the call site so evals exercise the same effort the
  // lead gets — a turn measured at the provider default proves nothing about production.
  it('runs the turn at a high reasoning effort', async () => {
    const opts = await defaultOptionsFor(DEFAULT_MODEL);
    expect(opts.providerOptions).toEqual({ openai: { reasoningEffort: 'high' } });
  });

  it('sends no effort for a tenant on a model that would reject it', async () => {
    const opts = await defaultOptionsFor('gpt-4o-mini');
    expect(opts.providerOptions).toEqual({});
  });
});
