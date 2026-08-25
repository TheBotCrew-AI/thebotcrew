import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ScheduledTurn } from './webhook-handler.js';

vi.mock('./webhook-handler.js', () => ({ runAgentTurn: vi.fn() }));
vi.mock('../roles/front-desk/index.js', () => ({ buildFrontDeskAgent: vi.fn(() => ({ id: 'agent' })) }));
vi.mock('../db/queries.js', () => ({ logBotEvent: vi.fn().mockResolvedValue(undefined) }));

import { runAgentTurn } from './webhook-handler.js';
import { buildFrontDeskAgent } from '../roles/front-desk/index.js';
import { logBotEvent } from '../db/queries.js';
import { ConversationDO } from './conversation-do.js';

function makeStorage() {
  return { put: vi.fn(), get: vi.fn(), delete: vi.fn(), setAlarm: vi.fn() };
}

const params = { conversationId: 'cv1', messageId: 'm1', tenant: { tenantId: 't1', clientId: 'client1' }, parsed: { conversationId: 'conv1' }, phone: '+521' } as unknown as ScheduledTurn;

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

describe('ConversationDO — resume after the human pause', () => {
  const PAUSE_ENDS = 10 * 60_000; // t=10min

  it('a pause-suppressed turn is stored back (flagged resumed) and the alarm re-armed past the expiry', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { doInst, storage } = makeDO();
    // First get: the pending turn. Second get (inside scheduleResume): nothing newer arrived.
    storage.get.mockResolvedValueOnce(params).mockResolvedValueOnce(undefined);
    vi.mocked(runAgentTurn).mockResolvedValue({
      status: 200,
      body: { ignored: 'bot suppressed', resumeAt: new Date(PAUSE_ENDS).toISOString() },
    });

    await doInst.alarm();

    expect(storage.put).toHaveBeenCalledWith('pendingTurn', { ...params, resumed: true });
    expect(storage.setAlarm).toHaveBeenCalledWith(PAUSE_ENDS + 5_000);
    expect(logBotEvent).toHaveBeenCalledWith('client1', 'conv1', 'turn_scheduled',
      expect.objectContaining({ via: 'pause-resume' }));
  });

  it('an expiry already in the past still fires soon, never immediately', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(PAUSE_ENDS + 60_000);
    const { doInst, storage } = makeDO();
    storage.get.mockResolvedValueOnce(params).mockResolvedValueOnce(undefined);
    vi.mocked(runAgentTurn).mockResolvedValue({
      status: 200,
      body: { resumeAt: new Date(PAUSE_ENDS).toISOString() },
    });

    await doInst.alarm();

    expect(storage.setAlarm).toHaveBeenCalledWith(PAUSE_ENDS + 60_000 + 5_000);
  });

  it('a NEWER inbound that arrived during the run keeps its own pending turn and 15s alarm', async () => {
    const { doInst, storage } = makeDO();
    const newer = { ...params, messageId: 'm2' } as ScheduledTurn;
    storage.get.mockResolvedValueOnce(params).mockResolvedValueOnce(newer);
    vi.mocked(runAgentTurn).mockResolvedValue({
      status: 200,
      body: { resumeAt: new Date(PAUSE_ENDS).toISOString() },
    });

    await doInst.alarm();

    expect(storage.put).not.toHaveBeenCalled();
    expect(storage.setAlarm).not.toHaveBeenCalled();
  });

  it('a permanent mute (no resumeAt) drops the turn as before', async () => {
    const { doInst, storage } = makeDO();
    storage.get.mockResolvedValue(params);
    vi.mocked(runAgentTurn).mockResolvedValue({ status: 200, body: { ignored: 'bot suppressed' } });

    await doInst.alarm();

    expect(storage.put).not.toHaveBeenCalled();
    expect(storage.setAlarm).not.toHaveBeenCalled();
  });

  it('a resumed turn that gets suppressed AGAIN (pause extended) re-arms once more', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { doInst, storage } = makeDO();
    const resumedParams = { ...params, resumed: true } as ScheduledTurn;
    storage.get.mockResolvedValueOnce(resumedParams).mockResolvedValueOnce(undefined);
    vi.mocked(runAgentTurn).mockResolvedValue({
      status: 200,
      body: { resumeAt: new Date(2 * PAUSE_ENDS).toISOString() },
    });

    await doInst.alarm();

    expect(runAgentTurn).toHaveBeenCalledWith(expect.objectContaining({ resumed: true }));
    expect(storage.setAlarm).toHaveBeenCalledWith(2 * PAUSE_ENDS + 5_000);
  });
});
