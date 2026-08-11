import { describe, it, expect } from 'vitest';
import { buildReactivationAgent, REACTIVATION_ROLE } from './agent.js';
import { RequestContext } from '@mastra/core/request-context';
import { DEFAULT_MODEL } from '../front-desk/agent.js';

describe('buildReactivationAgent', () => {
  it('constructs a fresh, tool-less agent', () => {
    const agent = buildReactivationAgent();
    expect(agent).toBeTruthy();
    expect(buildReactivationAgent()).not.toBe(agent);
  });

  it('exposes its role id', () => {
    expect(REACTIVATION_ROLE).toBe('reactivation');
  });

  // A nudge is one line off a supplied angle list, so it runs below the front-desk turn —
  // the cron pays this per silent lead.
  it('runs at a low reasoning effort', async () => {
    const requestContext = new RequestContext();
    requestContext.set('provider', 'openai');
    requestContext.set('model', DEFAULT_MODEL);
    const opts = await buildReactivationAgent().getDefaultOptions({ requestContext });
    expect(opts.providerOptions).toEqual({ openai: { reasoningEffort: 'low' } });
  });
});
