import { describe, it, expect } from 'vitest';
import { resolveAgentContext } from './agent-context.js';

const tenant = { tenantId: 't1', clientId: 'client1', config: { businessName: 'X', timezone: 'America/Mexico_City' } };
const turn = { ghlContactId: 'c1', ghlConversationId: 'conv1' };
const ctxWith = (map: Record<string, unknown>) => ({ requestContext: { get: (k: string) => map[k] } });

describe('resolveAgentContext', () => {
  it('throws when the request context is missing', () => {
    expect(() => resolveAgentContext({})).toThrow(/missing request context/);
  });

  it('throws when tenant or turn is absent', () => {
    expect(() => resolveAgentContext(ctxWith({ tenant }))).toThrow(/missing tenant\/turn/);
    expect(() => resolveAgentContext(ctxWith({ turn }))).toThrow(/missing tenant\/turn/);
  });

  it('returns tenant, turn and the parsed front-desk config', () => {
    const res = resolveAgentContext(ctxWith({ tenant, turn }));
    expect(res.tenant).toBe(tenant);
    expect(res.turn).toBe(turn);
    expect(res.config.businessName).toBe('X');
  });

  it('scopes booking_payment to the pinned variant (only_variants)', () => {
    const paying = { ...tenant, config: { ...tenant.config, bookingPayment: { amount: 500, only_variants: ['i01'] } } };
    expect(resolveAgentContext(ctxWith({ tenant: paying, turn: { ...turn, promptVariant: 'i01' } })).config.bookingPayment).toMatchObject({ amount: 500 });
    expect(resolveAgentContext(ctxWith({ tenant: paying, turn: { ...turn, promptVariant: 'a02' } })).config.bookingPayment).toBeNull();
    expect(resolveAgentContext(ctxWith({ tenant: paying, turn })).config.bookingPayment).toBeNull();
  });
});
