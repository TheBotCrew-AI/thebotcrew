import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ConversationMessage } from '../core/types.js';

vi.mock('../db/queries.js');

import type { AuxLlmCall } from './aux-llm.js';
import { classifyNeedsReply, formatTail, NEEDS_REPLY_PROMPT, parseNeedsReply } from './resume-gate.js';

const llm: AuxLlmCall = {
  clientId: 'client1',
  ghlConversationId: 'conv1',
  provider: 'openai',
  apiKey: 'k',
  model: 'gpt-5.6-luna',
  keySource: 'platform',
};

const msg = (senderType: ConversationMessage['senderType'], content: string): ConversationMessage => ({
  direction: senderType === 'lead' ? 'inbound' : 'outbound',
  senderType,
  content,
  sentAt: '2026-08-25T00:00:00Z',
});

const tail = [msg('lead', '¿Cuánto cuesta el paquete?'), msg('human_agent', 'Son $2,300'), msg('lead', 'Gracias')];

const stubModel = (content: string | null, ok = true) => {
  const fetchMock = vi.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 500,
    json: async () => ({ choices: [{ message: { content } }] }),
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('parseNeedsReply', () => {
  it('reads a boolean verdict', () => {
    expect(parseNeedsReply('{"needs_reply":true}')).toBe(true);
    expect(parseNeedsReply('{"needs_reply":false}')).toBe(false);
  });

  it('anything that is not a boolean verdict is null (the caller defaults to reply)', () => {
    expect(parseNeedsReply('')).toBeNull();
    expect(parseNeedsReply('{"needs_reply":"no"}')).toBeNull();
    expect(parseNeedsReply('{"status":"active"}')).toBeNull();
    expect(parseNeedsReply('not json')).toBeNull();
  });
});

describe('formatTail / prompt', () => {
  it('labels speakers so the model can tell the team from the bot from the lead', () => {
    expect(formatTail(tail)).toBe('[cliente] ¿Cuánto cuesta el paquete?\n[equipo] Son $2,300\n[cliente] Gracias');
  });

  it('the prompt ends on the last message and biases to replying when unsure', () => {
    const p = NEEDS_REPLY_PROMPT(tail);
    expect(p).toContain('[cliente] Gracias');
    expect(p).toMatch(/ante la duda, true/i);
  });
});

describe('classifyNeedsReply', () => {
  it('false verdict → no reply', async () => {
    stubModel('{"needs_reply":false}');
    await expect(classifyNeedsReply(tail, llm)).resolves.toBe(false);
  });

  it('true verdict → reply', async () => {
    stubModel('{"needs_reply":true}');
    await expect(classifyNeedsReply(tail, llm)).resolves.toBe(true);
  });

  it('a failed call defaults to REPLY — silence on a real question costs more than an extra message', async () => {
    stubModel(null, false);
    await expect(classifyNeedsReply(tail, llm)).resolves.toBe(true);
  });

  it('an unparseable answer defaults to reply too', async () => {
    stubModel('');
    await expect(classifyNeedsReply(tail, llm)).resolves.toBe(true);
  });

  it('an empty tail never calls the model', async () => {
    const fetchMock = stubModel('{"needs_reply":false}');
    await expect(classifyNeedsReply([], llm)).resolves.toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses the aux call contract: max_completion_tokens + JSON mode, never max_tokens', async () => {
    const fetchMock = stubModel('{"needs_reply":true}');
    await classifyNeedsReply(tail, llm);
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as { body: string }).body) as Record<string, unknown>;
    expect(body).not.toHaveProperty('max_tokens');
    expect(body.max_completion_tokens).toBeGreaterThanOrEqual(200);
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.reasoning_effort).toBe('none');
  });
});
