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
import { handleInboundWebhook, type TurnDONamespace } from '../worker/webhook-handler.js';
import { handleOutboundWebhook } from '../worker/outbound-handler.js';
import { handleTagWebhook } from '../worker/tag-handler.js';
import { handleAppointmentWebhook } from '../worker/appointment-webhook-handler.js';
import { verifyGhlWebhook, webhookAuthDisabled } from '../ghl/webhook.js';
import { retryPendingDeliveries } from '../worker/delivery-retry.js';
import { runPendingFollowUps } from '../worker/followup-runner.js';
import { runPendingCapiEvents } from '../worker/capi-runner.js';
import { runInfoGapExtractions, runPendingInfoAlerts } from '../worker/info-gap-runner.js';
import { exchangeCode, getInstallUrl } from '../ghl/oauth.js';
import { loadLatestInfoGapReport, upsertOAuthToken } from '../db/queries.js';
import { resolveTenant } from '../core/tenant.js';
import { executionCtxStorage, workerEnvStorage } from '../core/execution-ctx.js';
import type { GhlContactTagWebhook, GhlInboundWebhook, GhlOutboundWebhook } from '../ghl/types.js';

// Re-export so the getEntry() template can import them via '#mastra'.
export { executionCtxStorage, workerEnvStorage };
export { runPendingFollowUps } from '../worker/followup-runner.js';
export { retryPendingDeliveries } from '../worker/delivery-retry.js';
export { runPendingCapiEvents } from '../worker/capi-runner.js';
export { runInfoGapExtractions, runPendingInfoAlerts } from '../worker/info-gap-runner.js';
// The Durable Object class MUST be exported from the built Worker entry (index.mjs) for the
// runtime to instantiate it. The getEntry() override below re-exports it from '#mastra'.
export { ConversationDO } from '../worker/conversation-do.js';

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
          const raw = await c.req.text();
          if (!webhookAuthDisabled() && !(await verifyGhlWebhook(raw, c.req.raw.headers))) {
            return c.json({ error: 'invalid signature' }, 401);
          }
          let payload: GhlOutboundWebhook;
          try {
            payload = JSON.parse(raw) as GhlOutboundWebhook;
          } catch {
            return c.json({ error: 'invalid json body' }, 400);
          }
          const result = await handleOutboundWebhook(payload);
          return c.json(result.body, result.status);
        },
      }),

      // GHL contact tag webhook — the `bot-off` manual kill switch.
      // Configure this URL in the GHL App Marketplace for ContactTagUpdate events.
      registerApiRoute('/webhooks/ghl/tags', {
        method: 'POST',
        handler: async (c) => {
          const raw = await c.req.text();
          if (!webhookAuthDisabled() && !(await verifyGhlWebhook(raw, c.req.raw.headers))) {
            return c.json({ error: 'invalid signature' }, 401);
          }
          let payload: GhlContactTagWebhook;
          try {
            payload = JSON.parse(raw) as GhlContactTagWebhook;
          } catch {
            return c.json({ error: 'invalid json body' }, 400);
          }
          const result = await handleTagWebhook(payload);
          return c.json(result.body, result.status);
        },
      }),

      // Tenant-configured GHL WORKFLOW webhook (NOT a Marketplace event): staff books
      // an appointment in the GHL calendar → the workflow POSTs the ids here so the
      // booking reaches our stats + the 0049 parity actions run. Workflow webhooks are
      // unsigned, so auth is the shared GHL_WORKFLOW_SECRET (fails closed when unset).
      registerApiRoute('/webhooks/ghl/appointments', {
        method: 'POST',
        handler: async (c) => {
          let payload: unknown;
          try {
            payload = await c.req.json();
          } catch {
            return c.json({ error: 'invalid json body' }, 400);
          }
          const secret =
            (c.env as Record<string, string | undefined>).GHL_WORKFLOW_SECRET ?? process.env.GHL_WORKFLOW_SECRET;
          const result = await handleAppointmentWebhook(payload, c.req.header('authorization') ?? null, secret);
          return c.json(result.body, result.status);
        },
      }),

      registerApiRoute('/webhooks/ghl', {
        method: 'POST',
        handler: async (c) => {
          const m = c.get('mastra');
          const agent = m.getAgent('frontDesk');

          const raw = await c.req.text();
          if (!webhookAuthDisabled() && !(await verifyGhlWebhook(raw, c.req.raw.headers))) {
            return c.json({ error: 'invalid signature' }, 401);
          }
          let payload: GhlInboundWebhook;
          try {
            payload = JSON.parse(raw) as GhlInboundWebhook;
          } catch {
            return c.json({ error: 'invalid json body' }, 400);
          }

          // executionCtxStorage is populated by the entry point wrapper; falls back
          // to undefined (sync path) in test environments without a CF context.
          const execCtx = executionCtxStorage.getStore();
          // DO namespace binding (Phase 1 durable-turn path) — read from the real Worker env
          // threaded via workerEnvStorage; absent in local/test envs.
          const workerEnv = workerEnvStorage.getStore() as { CONVERSATION_DO?: TurnDONamespace } | undefined;
          const doNamespace = workerEnv?.CONVERSATION_DO;
          const result = await handleInboundWebhook(payload, agent, execCtx, doNamespace);
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

      // Triggered by the 1-minute cron to drain the Meta CAPI conversion-event queue (0048).
      registerApiRoute('/internal/run-capi', {
        method: 'POST',
        handler: async (c) => {
          const expected = (c.env as Record<string, string | undefined>).INTERNAL_CRON_SECRET;
          const auth = c.req.header('authorization') ?? '';
          if (!expected || auth !== `Bearer ${expected}`) {
            return c.json({ error: 'unauthorized' }, 401);
          }
          const result = await runPendingCapiEvents();
          console.log('[cron] run-capi:', result);
          return c.json(result);
        },
      }),

      // Info gaps (0054): the extraction drain (also rides the 5-minute cron) and the
      // daily escalation. Exposed so a run can be forced by hand — e.g. a tenant's first
      // report right after turning the feature on.
      registerApiRoute('/internal/run-info-gaps', {
        method: 'POST',
        handler: async (c) => {
          const expected = (c.env as Record<string, string | undefined>).INTERNAL_CRON_SECRET;
          const auth = c.req.header('authorization') ?? '';
          if (!expected || auth !== `Bearer ${expected}`) {
            return c.json({ error: 'unauthorized' }, 401);
          }
          const result = await runInfoGapExtractions();
          console.log('[cron] run-info-gaps:', result);
          return c.json(result);
        },
      }),
      registerApiRoute('/internal/run-pending-info-alerts', {
        method: 'POST',
        handler: async (c) => {
          const expected = (c.env as Record<string, string | undefined>).INTERNAL_CRON_SECRET;
          const auth = c.req.header('authorization') ?? '';
          if (!expected || auth !== `Bearer ${expected}`) {
            return c.json({ error: 'unauthorized' }, 401);
          }
          const result = await runPendingInfoAlerts();
          console.log('[cron] run-pending-info-alerts:', result);
          return c.json(result);
        },
      }),

      // The latest info-gap report for a tenant, as markdown. Read-only; its own secret
      // (REPORTS_SECRET) so sharing the report URL never shares the cron secret.
      registerApiRoute('/reports/info-gaps/:tenantId', {
        method: 'GET',
        handler: async (c) => {
          const expected = (c.env as Record<string, string | undefined>).REPORTS_SECRET;
          const auth = c.req.header('authorization') ?? '';
          if (!expected || auth !== `Bearer ${expected}`) {
            return c.json({ error: 'unauthorized' }, 401);
          }
          const tenantId = c.req.param('tenantId');
          if (!/^[0-9a-f-]{36}$/i.test(tenantId)) return c.json({ error: 'bad tenant id' }, 400);
          const report = await loadLatestInfoGapReport(tenantId);
          if (!report) return c.json({ error: 'no report yet' }, 404);
          return c.body(report.markdown, 200, {
            'content-type': 'text/markdown; charset=utf-8',
            'x-report-run': report.runId,
            'x-report-created-at': report.createdAt,
          });
        },
      }),

      // DO binding health check (Phase 0). Proves CONVERSATION_DO is bound and the RPC
      // path works, locally under `wrangler dev` and post-deploy. Bearer-secured.
      registerApiRoute('/internal/do-ping', {
        method: 'POST',
        handler: async (c) => {
          const expected = (c.env as Record<string, string | undefined>).INTERNAL_CRON_SECRET;
          const auth = c.req.header('authorization') ?? '';
          if (!expected || auth !== `Bearer ${expected}`) {
            return c.json({ error: 'unauthorized' }, 401);
          }
          // Binding objects live on the real Worker env (threaded via workerEnvStorage), not
          // on process.env or reliably on c.env. Loose type: we only need ping.
          const workerEnv = workerEnvStorage.getStore() as {
            CONVERSATION_DO?: { idFromName(n: string): DurableObjectId; get(id: DurableObjectId): { ping(): Promise<string> } };
          } | undefined;
          const ns = workerEnv?.CONVERSATION_DO;
          if (!ns) return c.json({ error: 'CONVERSATION_DO binding missing' }, 500);
          const stub = ns.get(ns.idFromName('healthcheck'));
          const pong = await stub.ping();
          return c.json({ pong });
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
      // 13:00 UTC = 06:00 Tijuana / 07:00 CDMX: the daily pending-info escalation (0054).
      triggers: { crons: ['* * * * *', '*/5 * * * *', '0 13 * * *'] },
      // Per-conversation Durable Object (turn/follow-up durability — see
      // docs/durable-objects-migration.md). CloudflareDeployer spreads this into the
      // generated wrangler.jsonc. Names are STICKY: don't rename ConversationDO / tag v1.
      durable_objects: {
        bindings: [{ name: 'CONVERSATION_DO', class_name: 'ConversationDO' }],
      },
      migrations: [{ tag: 'v1', new_sqlite_classes: ['ConversationDO'] }],
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

      // Durable Object class must be a named export of the Worker entry module so the
      // runtime can instantiate it for the CONVERSATION_DO binding.
      export { ConversationDO } from '#mastra';

      export default {
        fetch: async (request, env, context) => {
          const { mastra, executionCtxStorage, workerEnvStorage } = await import('#mastra');
          const { tools } = await import('#tools');
          const { createHonoServer, getToolExports } = await import('#server');
          const _mastra = mastra();

          if (_mastra.getStorage()) {
            _mastra.__registerInternalWorkflow(scoreTracesWorkflow);
          }

          const app = await createHonoServer(_mastra, { tools: getToolExports(tools) });
          return executionCtxStorage.run(context, () =>
            workerEnvStorage.run(env, () => app.fetch(request, env, context)),
          );
        },

        scheduled: async (event, _env, ctx) => {
          ctx.waitUntil((async () => {
            const { mastra, runPendingFollowUps, retryPendingDeliveries, runPendingCapiEvents, runInfoGapExtractions, runPendingInfoAlerts } = await import('#mastra');
            const _mastra = mastra();
            try {
              const reactivationAgent = _mastra.getAgent('reactivation');
              const result = await runPendingFollowUps(reactivationAgent);
              console.log('[cron] run-followups:', JSON.stringify(result));
            } catch (err) {
              console.error('[cron] run-followups error:', err instanceof Error ? err.message : String(err));
            }
            try {
              const result = await runPendingCapiEvents();
              console.log('[cron] run-capi:', JSON.stringify(result));
            } catch (err) {
              console.error('[cron] run-capi error:', err instanceof Error ? err.message : String(err));
            }
            if (event.cron === '*/5 * * * *') {
              try {
                const result = await retryPendingDeliveries();
                console.log('[cron] retry-deliveries:', JSON.stringify(result));
              } catch (err) {
                console.error('[cron] retry-deliveries error:', err instanceof Error ? err.message : String(err));
              }
              try {
                const result = await runInfoGapExtractions();
                console.log('[cron] run-info-gaps:', JSON.stringify(result));
              } catch (err) {
                console.error('[cron] run-info-gaps error:', err instanceof Error ? err.message : String(err));
              }
            }
            if (event.cron === '0 13 * * *') {
              try {
                const result = await runPendingInfoAlerts();
                console.log('[cron] run-pending-info-alerts:', JSON.stringify(result));
              } catch (err) {
                console.error('[cron] run-pending-info-alerts error:', err instanceof Error ? err.message : String(err));
              }
            }
          })());
        },
      }
    `;
    return d;
  })(),
});
