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
import { buildReactivationAgent } from '../roles/reactivation/index.js';
import { handleInboundWebhook } from '../worker/webhook-handler.js';
import { handleOutboundWebhook } from '../worker/outbound-handler.js';
import { handleTagWebhook } from '../worker/tag-handler.js';
import { retryPendingDeliveries } from '../worker/delivery-retry.js';
import { runPendingFollowUps } from '../worker/followup-runner.js';
import { exchangeCode, getInstallUrl } from '../ghl/oauth.js';
import { upsertOAuthToken } from '../db/queries.js';
import { resolveTenant } from '../core/tenant.js';
import { executionCtxStorage } from '../core/execution-ctx.js';
import type { GhlContactTagWebhook, GhlInboundWebhook, GhlOutboundWebhook } from '../ghl/types.js';

// Re-export so the getEntry() template can import them via '#mastra'.
export { executionCtxStorage };
export { runPendingFollowUps } from '../worker/followup-runner.js';
export { retryPendingDeliveries } from '../worker/delivery-retry.js';

const frontDesk = buildFrontDeskAgent();
const reactivation = buildReactivationAgent();

export const mastra = new Mastra({
  agents: { frontDesk, reactivation },
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

      // GHL outbound webhook — human agent messages (source: 'app').
      // Configure this URL in the GHL App Marketplace for OutboundMessage events.
      registerApiRoute('/webhooks/ghl/outbound', {
        method: 'POST',
        handler: async (c) => {
          let payload: GhlOutboundWebhook;
          try {
            payload = (await c.req.json()) as GhlOutboundWebhook;
          } catch {
            return c.json({ error: 'invalid json body' }, 400);
          }
          const result = await handleOutboundWebhook(payload, c.req.raw.headers);
          return c.json(result.body, result.status);
        },
      }),

      // GHL contact tag webhook — the `bot-off` manual kill switch.
      // Configure this URL in the GHL App Marketplace for ContactTagUpdate events.
      registerApiRoute('/webhooks/ghl/tags', {
        method: 'POST',
        handler: async (c) => {
          let payload: GhlContactTagWebhook;
          try {
            payload = (await c.req.json()) as GhlContactTagWebhook;
          } catch {
            return c.json({ error: 'invalid json body' }, 400);
          }
          const result = await handleTagWebhook(payload, c.req.raw.headers);
          return c.json(result.body, result.status);
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

          // executionCtxStorage is populated by the entry point wrapper; falls back
          // to undefined (sync path) in test environments without a CF context.
          const execCtx = executionCtxStorage.getStore();
          const result = await handleInboundWebhook(payload, c.req.raw.headers, agent, execCtx);
          return c.json(result.body, result.status);
        },
      }),

      // Triggered by the CF cron scheduled event (via self-fetch) to retry pending deliveries.
      // Secured with a bearer token so it can't be called by external parties.
      registerApiRoute('/internal/retry-deliveries', {
        method: 'POST',
        handler: async (c) => {
          const expected = (c.env as Record<string, string | undefined>).INTERNAL_CRON_SECRET;
          const auth = c.req.header('authorization') ?? '';
          if (!expected || auth !== `Bearer ${expected}`) {
            return c.json({ error: 'unauthorized' }, 401);
          }
          const result = await retryPendingDeliveries();
          console.log('[cron] retry-deliveries:', result);
          return c.json(result);
        },
      }),

      // Triggered by the 1-minute cron to send due follow-up messages.
      registerApiRoute('/internal/run-followups', {
        method: 'POST',
        handler: async (c) => {
          const expected = (c.env as Record<string, string | undefined>).INTERNAL_CRON_SECRET;
          const auth = c.req.header('authorization') ?? '';
          if (!expected || auth !== `Bearer ${expected}`) {
            return c.json({ error: 'unauthorized' }, 401);
          }
          const m = c.get('mastra');
          const agent = m.getAgent('reactivation');
          const result = await runPendingFollowUps(agent);
          console.log('[cron] run-followups:', result);
          return c.json(result);
        },
      }),
    ],
  },
  deployer: (() => {
    const d = new CloudflareDeployer({
      name: 'thebotcrew-agents',
      compatibility_date: '2025-06-01',
      compatibility_flags: ['nodejs_compat'],
      triggers: { crons: ['* * * * *', '*/5 * * * *'] },
    });
    // getEntry() is private upstream but we need to add a `scheduled` handler and
    // wrap each request in executionCtxStorage.run() so that route handlers can
    // access the CF ExecutionContext via executionCtxStorage.getStore().
    // Mastra's custom route handler strips the third fetch argument, so c.executionCtx
    // is unavailable inside registerApiRoute handlers — AsyncLocalStorage bridges the gap.
    // Re-verify this template when upgrading @mastra/deployer-cloudflare.
    (d as unknown as { getEntry(): string }).getEntry = () => `
      import '#polyfills';
      import { scoreTracesWorkflow } from '@mastra/core/evals/scoreTraces';

      export default {
        fetch: async (request, env, context) => {
          const { mastra, executionCtxStorage } = await import('#mastra');
          const { tools } = await import('#tools');
          const { createHonoServer, getToolExports } = await import('#server');
          const _mastra = mastra();

          if (_mastra.getStorage()) {
            _mastra.__registerInternalWorkflow(scoreTracesWorkflow);
          }

          const app = await createHonoServer(_mastra, { tools: getToolExports(tools) });
          return executionCtxStorage.run(context, () => app.fetch(request, env, context));
        },

        scheduled: async (event, _env, ctx) => {
          ctx.waitUntil((async () => {
            const { mastra, runPendingFollowUps, retryPendingDeliveries } = await import('#mastra');
            const _mastra = mastra();
            try {
              const reactivationAgent = _mastra.getAgent('reactivation');
              const result = await runPendingFollowUps(reactivationAgent);
              console.log('[cron] run-followups:', JSON.stringify(result));
            } catch (err) {
              console.error('[cron] run-followups error:', err instanceof Error ? err.message : String(err));
            }
            if (event.cron === '*/5 * * * *') {
              try {
                const result = await retryPendingDeliveries();
                console.log('[cron] retry-deliveries:', JSON.stringify(result));
              } catch (err) {
                console.error('[cron] retry-deliveries error:', err instanceof Error ? err.message : String(err));
              }
            }
          })());
        },
      }
    `;
    return d;
  })(),
});
