import { describe, it, expect, vi, beforeEach } from 'vitest';

const ghl = { sendMessage: vi.fn() };
vi.mock('../ghl/client.js', () => ({ GhlClient: vi.fn(() => ghl) }));
vi.mock('../db/queries.js');

import * as q from '../db/queries.js';
import { retryPendingDeliveries } from './delivery-retry.js';

type Pending = Awaited<ReturnType<typeof q.loadPendingDeliveries>>[number];
const pending = (o: Partial<Pending> = {}): Pending => ({
  messageId: 'msg1',
  content: 'hola',
  channel: 'whatsapp',
  ghlConversationId: 'conv1',
  ghlContactId: 'c1',
  contactPhone: '+521',
  tenantId: 't1',
  retryCount: 0,
  ...o,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(q.loadPendingDeliveries).mockResolvedValue([pending()]);
  vi.mocked(q.incrementRetryCount).mockResolvedValue(undefined);
  vi.mocked(q.setGhlMessageId).mockResolvedValue(undefined);
  vi.mocked(q.markDelivered).mockResolvedValue(undefined);
  vi.mocked(q.markDeliveryFailed).mockResolvedValue(undefined);
  ghl.sendMessage.mockResolvedValue({ ghlMessageId: 'g1' });
});

describe('retryPendingDeliveries', () => {
  it('nothing pending → no-op result', async () => {
    vi.mocked(q.loadPendingDeliveries).mockResolvedValue([]);
    expect(await retryPendingDeliveries()).toEqual({ tried: 0, delivered: 0, failed: 0 });
  });

  it('successful re-send → stores id, marks delivered', async () => {
    const res = await retryPendingDeliveries();
    expect(q.incrementRetryCount).toHaveBeenCalledWith('msg1');
    expect(q.setGhlMessageId).toHaveBeenCalledWith('msg1', 'g1');
    expect(q.markDelivered).toHaveBeenCalledWith('msg1');
    expect(res).toEqual({ tried: 1, delivered: 1, failed: 0 });
  });

  it('send fails with retries left → left pending, not marked failed', async () => {
    ghl.sendMessage.mockRejectedValue(new Error('ghl 500'));
    const res = await retryPendingDeliveries();
    expect(q.markDeliveryFailed).not.toHaveBeenCalled();
    expect(q.markDelivered).not.toHaveBeenCalled();
    expect(res).toEqual({ tried: 1, delivered: 0, failed: 0 });
  });

  it('send fails on the 3rd attempt → marked permanently failed', async () => {
    vi.mocked(q.loadPendingDeliveries).mockResolvedValue([pending({ retryCount: 2 })]); // → 3 after increment
    ghl.sendMessage.mockRejectedValue(new Error('ghl 500'));
    const res = await retryPendingDeliveries();
    expect(q.markDeliveryFailed).toHaveBeenCalledWith('msg1');
    expect(res).toEqual({ tried: 1, delivered: 0, failed: 1 });
  });
});
