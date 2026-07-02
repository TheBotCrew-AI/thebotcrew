/**
 * Test stub for the `cloudflare:workers` module, which isn't resolvable under
 * vitest/node (the real module is provided by the Workers runtime at deploy time).
 * Aliased in vitest.config.ts so importing ConversationDO doesn't blow up the unit run.
 * Only the DurableObject base class is needed for the class definition to load.
 */

export class DurableObject<Env = unknown> {
  protected ctx: DurableObjectState;
  protected env: Env;
  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}
