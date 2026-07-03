import { describe, it, expect, vi } from 'vitest';
import { executionCtxStorage, workerEnvStorage } from './execution-ctx.js';

describe('execution-ctx AsyncLocalStorage', () => {
  it('has no store outside a run() scope', () => {
    expect(executionCtxStorage.getStore()).toBeUndefined();
    expect(workerEnvStorage.getStore()).toBeUndefined();
  });

  it('threads the ExecutionContext through run()', () => {
    const ctx = { waitUntil: vi.fn() };
    executionCtxStorage.run(ctx, () => {
      expect(executionCtxStorage.getStore()).toBe(ctx);
      executionCtxStorage.getStore()?.waitUntil(Promise.resolve());
    });
    expect(ctx.waitUntil).toHaveBeenCalledOnce();
  });

  it('threads the Worker env (bindings) through run()', () => {
    const env = { CONVERSATION_DO: { fake: true } };
    workerEnvStorage.run(env, () => {
      expect(workerEnvStorage.getStore()).toBe(env);
    });
  });
});
