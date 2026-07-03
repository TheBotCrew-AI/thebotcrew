import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ScheduledTurn } from './webhook-handler.js';

vi.mock('./webhook-handler.js', () => ({ runAgentTurn: vi.fn() }));
vi.mock('../roles/front-desk/index.js', () => ({ buildFrontDeskAgent: vi.fn(() => ({ id: 'agent' })) }));

import { runAgentTurn } from './webhook-handler.js';
import { buildFrontDeskAgent } from '../roles/front-desk/index.js';
import { ConversationDO } from './conversation-do.js';

function makeStorage() {
  return { put: vi.fn(), get: vi.fn(), delete: vi.fn(), setAlarm: vi.fn() };
}

const params = { conversationId: 'cv1', messageId: 'm1', tenant: { tenantId: 't1' }, parsed: { conversationId: 'conv1' }, phone: '+521' } as unknown as ScheduledTurn;

function makeDO(storage = makeStorage(), env: Record<string, unknown> = { CONVERSATION_DO: {}, MY_SECRET: 'abc' }) {
  // ctx/env are protected on the stubbed DurableObject base; the DO reads this.ctx.storage.
  const doInst = new ConversationDO({ storage } as never, env as never);
  return { doInst, storage };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(runAgentTurn).mockResolvedValue({ status: 200, body: {} });
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.MY_SECRET;
});

describe('ConversationDO — constructor', () => {
  it('mirrors string env into process.env and skips binding objects', () => {
    makeDO(makeStorage(), { CONVERSATION_DO: { fake: 'ns' }, MY_SECRET: 'abc' });
    expect(process.env.MY_SECRET).toBe('abc');
    // the DO namespace object is not a string → never copied
    expect(process.env.CONVERSATION_DO).toBeUndefined();
  });
});

describe('ConversationDO — scheduleTurn (debounce)', () => {
  it('stores the pending turn and arms the 15s alarm', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { doInst, storage } = makeDO();

    await doInst.scheduleTurn(params);

    expect(storage.put).toHaveBeenCalledWith('pendingTurn', params);
    expect(storage.setAlarm).toHaveBeenCalledWith(15_000); // now(0) + 15s
  });

  it('a later message overwrites the pending turn and resets the alarm', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const { doInst, storage } = makeDO();

    const next = { ...params, messageId: 'm2' } as ScheduledTurn;
    await doInst.scheduleTurn(next);

    expect(storage.put).toHaveBeenLastCalledWith('pendingTurn', next);
    expect(storage.setAlarm).toHaveBeenLastCalledWith(16_000);
  });
});

describe('ConversationDO — alarm', () => {
  it('no pending turn → no-op', async () => {
    const { doInst, storage } = makeDO();
    storage.get.mockResolvedValue(undefined);

    await doInst.alarm();

    expect(storage.delete).not.toHaveBeenCalled();
    expect(runAgentTurn).not.toHaveBeenCalled();
  });

  it('pending turn → clears it, builds the agent, runs the turn (debounced)', async () => {
    const { doInst, storage } = makeDO();
    storage.get.mockResolvedValue(params);

    await doInst.alarm();

    expect(storage.delete).toHaveBeenCalledWith('pendingTurn');
    expect(buildFrontDeskAgent).toHaveBeenCalledOnce();
    expect(runAgentTurn).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'cv1', messageId: 'm1', debounced: true, agent: { id: 'agent' } }),
    );
  });

  it('swallows a turn failure so CF does not auto-retry the alarm (no double-send)', async () => {
    const { doInst, storage } = makeDO();
    storage.get.mockResolvedValue(params);
    vi.mocked(runAgentTurn).mockRejectedValue(new Error('turn blew up'));

    await expect(doInst.alarm()).resolves.toBeUndefined();
  });
});
