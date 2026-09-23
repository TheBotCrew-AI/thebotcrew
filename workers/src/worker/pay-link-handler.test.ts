import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db/queries.js');

import * as q from '../db/queries.js';
import { resolvePayLink } from './pay-link-handler.js';

const STRIPE = 'https://checkout.stripe.com/c/pay/cs_test_abc#fidkdWxOYHwn';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /p/:code — resolvePayLink', () => {
  it('pending → 302 to the stored Stripe URL, fragment and all', async () => {
    vi.mocked(q.getBookingHoldByShortCode).mockResolvedValue({ status: 'pending', checkoutUrl: STRIPE });
    expect(await resolvePayLink('x7k2m9qwab')).toEqual({ kind: 'redirect', status: 302, location: STRIPE });
    expect(q.getBookingHoldByShortCode).toHaveBeenCalledWith('x7k2m9qwab');
  });

  it('the code is normalized before the lookup (autocapitalized, padded)', async () => {
    vi.mocked(q.getBookingHoldByShortCode).mockResolvedValue({ status: 'pending', checkoutUrl: STRIPE });
    await resolvePayLink(' X7K2M9QWAB ');
    expect(q.getBookingHoldByShortCode).toHaveBeenCalledWith('x7k2m9qwab');
  });

  it('paid / paid_late → 200 "ya está pagado", never Stripe', async () => {
    for (const status of ['paid', 'paid_late'] as const) {
      vi.mocked(q.getBookingHoldByShortCode).mockResolvedValue({ status, checkoutUrl: STRIPE });
      const out = await resolvePayLink('x7k2m9qwab');
      expect(out.kind).toBe('page');
      expect(out.status).toBe(200);
      expect(out.kind === 'page' && out.html).toContain('ya está pagado');
      expect(out.kind === 'page' && out.html).not.toContain(STRIPE);
    }
  });

  it('expired / cancelled / expiring → 410 "venció", pointing back to the chat', async () => {
    for (const status of ['expired', 'cancelled', 'expiring'] as const) {
      vi.mocked(q.getBookingHoldByShortCode).mockResolvedValue({ status, checkoutUrl: STRIPE });
      const out = await resolvePayLink('x7k2m9qwab');
      expect(out.status).toBe(410);
      expect(out.kind === 'page' && out.html).toContain('venció');
      expect(out.kind === 'page' && out.html).toContain('chat');
    }
  });

  it('unknown code → 404; malformed code → 404 without touching the DB', async () => {
    vi.mocked(q.getBookingHoldByShortCode).mockResolvedValue(null);
    expect((await resolvePayLink('x7k2m9qwab')).status).toBe(404);
    vi.clearAllMocks();
    expect((await resolvePayLink('nope')).status).toBe(404);
    expect((await resolvePayLink("abcdefghjk'--")).status).toBe(404);
    expect(q.getBookingHoldByShortCode).not.toHaveBeenCalled();
  });
});
