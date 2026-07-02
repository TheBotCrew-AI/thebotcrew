/**
 * ConversationDO — per-conversation Durable Object (Phase 0 scaffold).
 *
 * Addressed by conversation id. A DO instance runs single-threaded, so all processing
 * for one conversation is serialized — the double-run / race class disappears by
 * construction. Phases 1–2 move the debounced turn and the follow-up scheduling onto
 * this object's durable Alarm; Phase 0 is just the class, its binding, and an RPC ping
 * to prove the wiring. No behavior change yet.
 *
 * See docs/durable-objects-migration.md.
 */

import { DurableObject } from 'cloudflare:workers';

/** Bindings the DO needs. Phase 0: only the self-reference. Turn/DB/AI secrets land in Phase 1. */
export interface ConversationDoEnv {
  CONVERSATION_DO: DurableObjectNamespace<ConversationDO>;
}

export class ConversationDO extends DurableObject<ConversationDoEnv> {
  /** RPC health check — proves the binding + RPC path end to end (see /internal/do-ping). */
  async ping(): Promise<string> {
    return `pong from ${this.ctx.id.toString()}`;
  }

  /** Durable Alarm handler. Phases 1–2 run the debounced turn / follow-up here. */
  override async alarm(): Promise<void> {
    console.log(`[ConversationDO] alarm fired for ${this.ctx.id.toString()}`);
  }
}
