/**
 * Mastra instance — the deployable app.
 *
 * Registers the agents, exposes the GHL webhook as a custom server route, and
 * configures the Cloudflare deployer. `mastra dev` and `mastra build` both read
 * this file (src/mastra/index.ts) by convention.
 */

import { Mastra } from '@mastra/core/mastra';
import { registerApiRoute } from '@mastra/core/server';
import { CloudflareDeployer } from '@mastra/deployer-cloudflare';
import { buildFrontDeskAgent } from '../roles/front-desk/index.js';
import { handleInboundWebhook } from '../worker/webhook-handler.js';
import type { GhlInboundWebhook } from '../ghl/types.js';

const frontDesk = buildFrontDeskAgent();

export const mastra = new Mastra({
  agents: { frontDesk },
  server: {
    apiRoutes: [
      registerApiRoute('/webhooks/ghl', {
        method: 'POST',
        handler: async (c) => {
          const m = c.get('mastra');
          const agent = m.getAgent('frontDesk');

          let payload: GhlInboundWebhook;
          try {
            payload = (await c.req.json()) as GhlInboundWebhook;
          } catch {
            return c.json({ error: 'invalid json body' }, 400);
          }

          const result = await handleInboundWebhook(payload, c.req.raw.headers, agent);
          return c.json(result.body, result.status);
        },
      }),
    ],
  },
  deployer: new CloudflareDeployer({
    name: 'thebotcrew-agents',
    compatibility_date: '2025-06-01',
    compatibility_flags: ['nodejs_compat'],
  }),
});
