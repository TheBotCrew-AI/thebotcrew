import { describe, it, expect, vi, beforeEach } from 'vitest';
import { findUnansweredInbound } from './queries.js';
import { getSupabase } from './client.js';

vi.mock('./client.js', () => ({ getSupabase: vi.fn() }));

type Result = { data: unknown; error: null };

/**
 * A chainable stand-in for the three queries findUnansweredInbound makes, keyed by table.
 * Every builder method returns itself; `maybeSingle` resolves the table's canned row.
 */
function supabaseWith(rows: { conversations?: unknown; messages?: unknown; bot_events?: unknown }) {
  const calls: Record<string, Record<string, unknown[]>> = {};
  const from = (table: keyof typeof rows) => {
    const log: Record<string, unknown[]> = {};
    calls[table] = log;
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'order', 'limit', 'gte']) {
      chain[m] = (...args: unknown[]) => {
        (log[m] ??= []).push(args);
        return chain;
      };
    }
    chain.maybeSingle = async (): Promise<Result> => ({ data: rows[table] ?? null, error: null });
    return chain;
  };
  vi.mocked(getSupabase).mockReturnValue({ from } as never);
  return calls;
}

const lead = { id: 'msg-lead', sender_type: 'lead', sent_at: '2026-08-27T15:18:30.575Z' };

beforeEach(() => vi.clearAllMocks());

describe('findUnansweredInbound — dedup recovery signal', () => {
  it('unanswered lead message with NO turn_scheduled since it → recoverable, regardless of age', async () => {
    // The 2026-08-27 case: GHL retried 18 s after the first request died before scheduling.
    supabaseWith({ conversations: { id: 'cv' }, messages: lead, bot_events: null });
    await expect(findUnansweredInbound('ghl-conv')).resolves.toEqual({ conversationId: 'cv', messageId: 'msg-lead' });
  });

  it('a turn already scheduled for that message → null (the retry must not run it twice)', async () => {
    const calls = supabaseWith({ conversations: { id: 'cv' }, messages: lead, bot_events: { id: 'ev' } });
    await expect(findUnansweredInbound('ghl-conv')).resolves.toBeNull();
    // The event lookup is scoped to this conversation, this event type, and AFTER the message.
    expect(calls.bot_events?.eq).toEqual([['conversation_id', 'cv'], ['event_type', 'turn_scheduled']]);
    expect(calls.bot_events?.gte).toEqual([['created_at', lead.sent_at]]);
  });

  it('latest message is the bot\'s → null, and the event table is not even consulted', async () => {
    const calls = supabaseWith({ conversations: { id: 'cv' }, messages: { ...lead, id: 'msg-bot', sender_type: 'bot' } });
    await expect(findUnansweredInbound('ghl-conv')).resolves.toBeNull();
    expect(calls.bot_events).toBeUndefined();
  });

  it('latest message is a human teammate\'s → null', async () => {
    supabaseWith({ conversations: { id: 'cv' }, messages: { ...lead, sender_type: 'human_agent' } });
    await expect(findUnansweredInbound('ghl-conv')).resolves.toBeNull();
  });

  it('unknown conversation → null', async () => {
    supabaseWith({ conversations: null });
    await expect(findUnansweredInbound('ghl-conv')).resolves.toBeNull();
  });
});
