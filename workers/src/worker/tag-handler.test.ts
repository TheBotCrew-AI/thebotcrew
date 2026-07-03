import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TenantContext } from '../core/types.js';

vi.mock('../core/tenant.js');
vi.mock('../db/queries.js');
vi.mock('../ghl/webhook.js');

import { resolveTenant } from '../core/tenant.js';
import * as q from '../db/queries.js';
import { parseContactTagWebhook } from '../ghl/webhook.js';
import { BOT_OFF_TAG } from '../ghl/tags.js';
import { handleTagWebhook } from './tag-handler.js';

const tenant = { tenantId: 't1', clientId: 'client1', ghlLocationId: 'loc1' } as unknown as TenantContext;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resolveTenant).mockResolvedValue(tenant);
  vi.mocked(parseContactTagWebhook).mockReturnValue({ locationId: 'loc1', contactId: 'c1', tags: [] });
  vi.mocked(q.setBotOffByContact).mockResolvedValue(0);
  vi.mocked(q.logBotEvent).mockResolvedValue(undefined);
});

describe('handleTagWebhook', () => {
  it('not a contact tag update → ignored, tenant never resolved', async () => {
    vi.mocked(parseContactTagWebhook).mockReturnValue(null);
    const res = await handleTagWebhook({} as never);
    expect(res.body).toMatchObject({ ignored: 'not a contact tag update' });
    expect(resolveTenant).not.toHaveBeenCalled();
  });

  it('unknown tenant → ignored, no DB write', async () => {
    vi.mocked(resolveTenant).mockResolvedValue(null);
    const res = await handleTagWebhook({} as never);
    expect(res.body).toMatchObject({ ignored: 'unknown or inactive tenant' });
    expect(q.setBotOffByContact).not.toHaveBeenCalled();
  });

  it('bot-off tag present → hands off the contact + logs handoff_tag_on', async () => {
    vi.mocked(parseContactTagWebhook).mockReturnValue({ locationId: 'loc1', contactId: 'c1', tags: [BOT_OFF_TAG] });
    vi.mocked(q.setBotOffByContact).mockResolvedValue(1);

    const res = await handleTagWebhook({} as never);

    expect(q.setBotOffByContact).toHaveBeenCalledWith('c1', true);
    expect(q.logBotEvent).toHaveBeenCalledWith('client1', '', 'handoff_tag_on', expect.objectContaining({ contactId: 'c1', affected: 1 }));
    expect(res.body).toMatchObject({ ok: true, botOff: true, affected: 1 });
  });

  it('bot-off tag absent → reactivates + logs handoff_tag_off', async () => {
    vi.mocked(parseContactTagWebhook).mockReturnValue({ locationId: 'loc1', contactId: 'c1', tags: ['some-other-tag'] });
    vi.mocked(q.setBotOffByContact).mockResolvedValue(1);

    const res = await handleTagWebhook({} as never);

    expect(q.setBotOffByContact).toHaveBeenCalledWith('c1', false);
    expect(q.logBotEvent).toHaveBeenCalledWith('client1', '', 'handoff_tag_off', expect.anything());
    expect(res.body).toMatchObject({ ok: true, botOff: false, affected: 1 });
  });

  it('no rows affected → no event logged (no-op, e.g. bot self-handoff echo)', async () => {
    vi.mocked(parseContactTagWebhook).mockReturnValue({ locationId: 'loc1', contactId: 'c1', tags: [BOT_OFF_TAG] });
    vi.mocked(q.setBotOffByContact).mockResolvedValue(0);

    const res = await handleTagWebhook({} as never);

    expect(q.logBotEvent).not.toHaveBeenCalled();
    expect(res.body).toMatchObject({ affected: 0 });
  });

  it('DB write throws → 500', async () => {
    vi.mocked(q.setBotOffByContact).mockRejectedValue(new Error('db down'));
    const res = await handleTagWebhook({} as never);
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ error: 'tag_handoff_failed' });
  });
});
