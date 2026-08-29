import { describe, it, expect, vi } from 'vitest';
import { syncContactTimezone } from './contact-timezone.js';

describe('syncContactTimezone', () => {
  it('writes the zone to the contact and reports success', async () => {
    const ghl = { updateContactTimezone: vi.fn().mockResolvedValue(undefined) };
    expect(await syncContactTimezone(ghl, 'c1', 'America/Cancun', 'test')).toBe(true);
    expect(ghl.updateContactTimezone).toHaveBeenCalledWith('c1', 'America/Cancun');
  });

  it('never throws — a GHL failure is logged and reported as false', async () => {
    const ghl = { updateContactTimezone: vi.fn().mockRejectedValue(new Error('[ghl] updateContactTimezone failed 500')) };
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await syncContactTimezone(ghl, 'c1', 'America/Cancun', 'bookAppointment')).toBe(false);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('at bookAppointment'), expect.stringContaining('500'));
    spy.mockRestore();
  });
});
