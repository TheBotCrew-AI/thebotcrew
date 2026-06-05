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
import { exchangeCode, getInstallUrl } from '../ghl/oauth.js';
import { upsertOAuthToken } from '../db/queries.js';
import { resolveTenant } from '../core/tenant.js';
import type { GhlInboundWebhook } from '../ghl/types.js';

const frontDesk = buildFrontDeskAgent();

export const mastra = new Mastra({
  agents: { frontDesk },
  server: {
    apiRoutes: [
      // Redirect to the GHL App Marketplace authorization page to install the app.
      registerApiRoute('/oauth/ghl/install', {
        method: 'GET',
        handler: async (c) => {
          // state is a random nonce — GHL echoes it back so we can verify the callback
          // is legitimate. Full CSRF verification (store + compare) can be added later.
          const state = crypto.randomUUID();
          return c.redirect(getInstallUrl(state));
        },
      }),

      // GHL redirects here after the user approves the app install.
      registerApiRoute('/oauth/callback', {
        method: 'GET',
        handler: async (c) => {
          const code = c.req.query('code');
          // GHL may send locationId as a query param or inside the token response.
          const locationIdParam = c.req.query('locationId') ?? c.req.query('location_id');

          if (!code) {
            return c.json({ error: 'missing code' }, 400);
          }

          let tokens;
          try {
            tokens = await exchangeCode(code);
          } catch (err) {
            const detail = err instanceof Error ? err.message : String(err);
            return c.json({ error: 'token_exchange_failed', detail }, 500);
          }

          const locationId = locationIdParam ?? tokens.locationId;
          if (!locationId) {
            return c.json({ error: 'could not determine locationId from callback' }, 400);
          }

          const tenant = await resolveTenant(locationId);
          if (!tenant) {
            return c.json({ error: 'unknown_location', locationId }, 404);
          }

          await upsertOAuthToken(tenant.tenantId, tokens);

          return c.html(
            '<!doctype html><html><body style="font-family:sans-serif;padding:2rem">' +
              '<h2>¡Conectado!</h2>' +
              '<p>GoHighLevel se conectó correctamente. Puedes cerrar esta ventana.</p>' +
              '</body></html>',
          );
        },
      }),

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
