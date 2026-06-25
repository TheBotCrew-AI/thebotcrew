import { AsyncLocalStorage } from 'node:async_hooks';

export interface ExecutionCtx {
  waitUntil(promise: Promise<unknown>): void;
}

/**
 * Threads the Cloudflare ExecutionContext from the Worker entry point down to
 * any code running within the same request. Necessary because Mastra's custom
 * route handler calls app.fetch(request, env) without the third CF argument,
 * so c.executionCtx is unavailable in route handlers.
 *
 * Usage:
 *   Entry: executionCtxStorage.run(context, () => app.fetch(request, env, context))
 *   Handler: const ctx = executionCtxStorage.getStore()
 */
export const executionCtxStorage = new AsyncLocalStorage<ExecutionCtx>();
