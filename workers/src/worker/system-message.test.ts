import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TenantContext } from '../core/types.js';

vi.mock('../db/queries.js');
const ghl = { sendMessage: vi.fn() };
vi.mock('../ghl/client.js', () => ({ GhlClient: vi.fn(() => ghl) }));

import * as q from '../db/queries.js';
import { sendSystemMessage, SYSTEM_MESSAGE_ROLE } from './system-message.js';

const tenant = { tenantId: 't1', clientId: 'client1' } as unknown as TenantContext;
const args = {
  tenant,
  ghlConversationId: 'conv1',
  ghlContactId: 'c1',
  channel: 'whatsapp',
  contactPhone: '+52664',
  text: 'hola',
  tag: 'test',
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(q.isBotSuppressed).mockResolvedValue(false);
  vi.mocked(q.logMessage).mockResolvedValue({ conversationId: 'cv', messageId: 'm1' });
  vi.mocked(q.setGhlMessageId).mockResolvedValue(undefined);
  vi.mocked(q.markDelivered).mockResolvedValue(undefined);
  vi.mocked(q.updateConversationContact).mockResolvedValue(undefined);
  ghl.sendMessage.mockResolvedValue({ ghlMessageId: 'g1' });
});

describe('sendSystemMessage', () => {
  it('logs the outbound row as role "system" BEFORE sending, then marks delivered', async () => {
    expect(await sendSystemMessage(args)).toBe('sent');
    expect(q.logMessage).toHaveBeenCalledWith(expect.objectContaining({ p_direction: 'outbound', p_sender_type: 'bot', p_agent_role: SYSTEM_MESSAGE_ROLE, p_content: 'hola', p_model: null }));
    expect(ghl.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ contactId: 'c1', channel: 'whatsapp', text: 'hola', phone: '+52664' }));
    expect(vi.mocked(q.logMessage).mock.invocationCallOrder[0]!).toBeLessThan(ghl.sendMessage.mock.invocationCallOrder[0]!);
    expect(q.setGhlMessageId).toHaveBeenCalledWith('m1', 'g1');
    expect(q.markDelivered).toHaveBeenCalledWith('m1');
  });

  it('human active / handed off → suppressed, nothing logged or sent', async () => {
    vi.mocked(q.isBotSuppressed).mockResolvedValue(true);
    expect(await sendSystemMessage(args)).toBe('suppressed');
    expect(q.logMessage).not.toHaveBeenCalled();
    expect(ghl.sendMessage).not.toHaveBeenCalled();
  });

  it('send failure → failed, the row stays pending for the retry cron', async () => {
    ghl.sendMessage.mockRejectedValue(new Error('CONVERSATIONS_CONTACT_NOT_FOUND'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await sendSystemMessage(args)).toBe('failed');
    expect(q.markDelivered).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('a merged-away contact recovered on send is persisted', async () => {
    ghl.sendMessage.mockResolvedValue({ ghlMessageId: 'g1', resolvedContactId: 'c-new' });
    await sendSystemMessage(args);
    expect(q.updateConversationContact).toHaveBeenCalledWith('conv1', 'c-new');
  });
});
