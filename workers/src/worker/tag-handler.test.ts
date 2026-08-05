import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TenantContext } from '../core/types.js';

vi.mock('../core/tenant.js');
vi.mock('../db/queries.js');
vi.mock('../ghl/webhook.js');

import { resolveTenant } from '../core/tenant.js';
import * as q from '../db/queries.js';
import { parseContactTagWebhook } from '../ghl/webhook.js';
import { BOT_OFF_TAG, OPTED_OUT_TAG } from '../ghl/tags.js';
import { handleTagWebhook } from './tag-handler.js';

const tenant = { tenantId: 't1', clientId: 'client1', ghlLocationId: 'loc1' } as unknown as TenantContext;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resolveTenant).mockResolvedValue(tenant);
  vi.mocked(parseContactTagWebhook).mockReturnValue({ locationId: 'loc1', contactId: 'c1', tags: [] });
  vi.mocked(q.setBotOffByContact).mockResolvedValue(0);
  vi.mocked(q.setAwaitingHumanByContact).mockResolvedValue(0);
  vi.mocked(q.clearOptedOutByContact).mockResolvedValue(0);
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

  describe("the tenant's awaiting-human tag", () => {
    const withTag = { ...tenant, awaitingHumanTag: 'esperando-agenda' } as unknown as TenantContext;

    it('tenant has no tag configured → that switch is never touched', async () => {
      vi.mocked(parseContactTagWebhook).mockReturnValue({ locationId: 'loc1', contactId: 'c1', tags: ['whatever'] });
      await handleTagWebhook({} as never);
      expect(q.setAwaitingHumanByContact).not.toHaveBeenCalled();
    });

    it('tag present → marks the contact as awaiting a person', async () => {
      vi.mocked(resolveTenant).mockResolvedValue(withTag);
      vi.mocked(parseContactTagWebhook).mockReturnValue({ locationId: 'loc1', contactId: 'c1', tags: ['esperando-agenda'] });
      vi.mocked(q.setAwaitingHumanByContact).mockResolvedValue(1);

      const res = await handleTagWebhook({} as never);

      expect(q.setAwaitingHumanByContact).toHaveBeenCalledWith('c1', true);
      expect(res.body).toMatchObject({ awaitingAffected: 1 });
    });

    it('tag removed → back to active, which is what re-arms follow-ups', async () => {
      // The owner clearing the tag IS the "I handled it" action; it drives the state.
      vi.mocked(resolveTenant).mockResolvedValue(withTag);
      vi.mocked(parseContactTagWebhook).mockReturnValue({ locationId: 'loc1', contactId: 'c1', tags: [] });
      vi.mocked(q.setAwaitingHumanByContact).mockResolvedValue(1);

      await handleTagWebhook({} as never);

      expect(q.setAwaitingHumanByContact).toHaveBeenCalledWith('c1', false);
    });

    it('a failure here does not 500 the webhook — the bot-off switch already applied', async () => {
      // GHL retries on 500; re-running a kill-switch that already landed is worse than
      // losing this secondary write.
      vi.mocked(resolveTenant).mockResolvedValue(withTag);
      vi.mocked(parseContactTagWebhook).mockReturnValue({ locationId: 'loc1', contactId: 'c1', tags: ['esperando-agenda'] });
      vi.mocked(q.setAwaitingHumanByContact).mockRejectedValue(new Error('db down'));

      const res = await handleTagWebhook({} as never);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ ok: true });
    });
  });

  describe('the pending-info tag (0050) — a second queue, the same state', () => {
    // `esperando-agenda` = the client owes her a booking. `dato-pendiente` = WE owe her
    // a fact the config lacks. Different people clear them, so they must be different
    // tags — but both mean "don't nudge her, we owe her an answer", so they OR.
    const bothTags = {
      ...tenant,
      awaitingHumanTag: 'esperando-agenda',
      pendingInfoTag: 'dato-pendiente',
    } as unknown as TenantContext;

    it('pending-info tag alone → parks the contact, even with no booking tag', async () => {
      vi.mocked(resolveTenant).mockResolvedValue(bothTags);
      vi.mocked(parseContactTagWebhook).mockReturnValue({ locationId: 'loc1', contactId: 'c1', tags: ['dato-pendiente'] });
      vi.mocked(q.setAwaitingHumanByContact).mockResolvedValue(1);

      await handleTagWebhook({} as never);

      expect(q.setAwaitingHumanByContact).toHaveBeenCalledWith('c1', true);
    });

    it('clearing ONLY the booking tag keeps her parked while the data point is pending', async () => {
      // The trap this closes: two tags, one state. If the booking tag drove the flip on
      // its own, answering the scheduling half would re-arm the nudges — and she'd get
      // "¿sigues interesada?" while still waiting on the answer we promised.
      vi.mocked(resolveTenant).mockResolvedValue(bothTags);
      vi.mocked(parseContactTagWebhook).mockReturnValue({ locationId: 'loc1', contactId: 'c1', tags: ['dato-pendiente'] });
      vi.mocked(q.setAwaitingHumanByContact).mockResolvedValue(1);

      await handleTagWebhook({} as never);

      expect(q.setAwaitingHumanByContact).not.toHaveBeenCalledWith('c1', false);
    });

    it('both tags gone → back to active and the follow-ups resume', async () => {
      vi.mocked(resolveTenant).mockResolvedValue(bothTags);
      vi.mocked(parseContactTagWebhook).mockReturnValue({ locationId: 'loc1', contactId: 'c1', tags: ['otro'] });
      vi.mocked(q.setAwaitingHumanByContact).mockResolvedValue(1);

      await handleTagWebhook({} as never);

      expect(q.setAwaitingHumanByContact).toHaveBeenCalledWith('c1', false);
    });

    it('a tenant with ONLY the pending-info tag still gets the switch', async () => {
      // awaiting_human_tag is NULL for every tenant that books through the bot; the
      // config-gap queue is not theirs to opt out of.
      vi.mocked(resolveTenant).mockResolvedValue({ ...tenant, pendingInfoTag: 'dato-pendiente' } as unknown as TenantContext);
      vi.mocked(parseContactTagWebhook).mockReturnValue({ locationId: 'loc1', contactId: 'c1', tags: ['dato-pendiente'] });
      vi.mocked(q.setAwaitingHumanByContact).mockResolvedValue(1);

      await handleTagWebhook({} as never);

      expect(q.setAwaitingHumanByContact).toHaveBeenCalledWith('c1', true);
    });
  });

  describe('the opt-out undo tag (0045)', () => {
    // Since 0045 `opted_out` mutes the bot like `handed_off`, and it is set by an LLM
    // classifier. Removing this tag is the only way back from a false positive that
    // isn't hand-written SQL.
    it('tag absent → clears the opt-out so the bot can speak again', async () => {
      vi.mocked(q.clearOptedOutByContact).mockResolvedValue(1);
      const res = await handleTagWebhook({} as never);
      expect(q.clearOptedOutByContact).toHaveBeenCalledWith('c1');
      expect(res.body).toMatchObject({ optOutCleared: 1 });
    });

    it('tag present → nothing happens: adding it opts NOBODY out', async () => {
      // One-directional on purpose. The lead's "stop" is not something an operator
      // can assert on their behalf — only something they can decide was misread.
      vi.mocked(parseContactTagWebhook).mockReturnValue({
        locationId: 'loc1', contactId: 'c1', tags: [OPTED_OUT_TAG],
      });
      await handleTagWebhook({} as never);
      expect(q.clearOptedOutByContact).not.toHaveBeenCalled();
    });

    it('the bot writing the tag itself cannot loop back into a clear', async () => {
      // GHL fires this webhook for bot-written tags too; the bot only ever ADDS it.
      vi.mocked(parseContactTagWebhook).mockReturnValue({
        locationId: 'loc1', contactId: 'c1', tags: [OPTED_OUT_TAG, 'bot-standby'],
      });
      await handleTagWebhook({} as never);
      expect(q.clearOptedOutByContact).not.toHaveBeenCalled();
    });

    it('a failure here does not 500 the webhook', async () => {
      vi.mocked(q.clearOptedOutByContact).mockRejectedValue(new Error('db down'));
      const res = await handleTagWebhook({} as never);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ ok: true, optOutCleared: 0 });
    });
  });
});
