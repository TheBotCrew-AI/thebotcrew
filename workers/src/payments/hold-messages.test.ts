import { describe, it, expect } from 'vitest';
import { buildHoldExpiredMessage, buildHoldPaidLateMessage, buildHoldPaidMessage, buildHoldReminderMessage } from './hold-messages.js';

describe('hold messages (LLM-free)', () => {
  // Live 2026-09-23 (Heriberto's Connect test): "…3:45 p.m.." — the label already ends in a period.
  it('paid: no double period after a "p.m." label, still a period after a plain one', () => {
    expect(buildHoldPaidMessage('lunes, 28 de septiembre, 3:45 p.m.', 'Dr. Heriberto Valdivia')).toContain('3:45 p.m. Si algo');
    expect(buildHoldPaidMessage('lunes, 28 de septiembre, 3:45 p.m.', 'X')).not.toContain('..');
    expect(buildHoldPaidMessage('lunes 28, 15:45', 'X')).toContain('15:45. Si algo');
  });
  it('expired and paid_late carry the label / the business, nothing about refunds', () => {
    expect(buildHoldExpiredMessage('lunes, 28 de septiembre, 3:45 p.m.')).toContain('3:45 p.m. y el lugar');
    expect(buildHoldPaidLateMessage('Clínica')).toContain('Clínica');
    expect(buildHoldPaidLateMessage('Clínica')).not.toMatch(/reembolso|devoluci/);
  });
  it('reminder (0065): cita, deadline, "ignora si ya pagaste", and the link LAST on its own line', () => {
    const m = buildHoldReminderMessage('lunes, 28 de septiembre, 3:45 p.m.', 'lunes, 28 de septiembre, 1:45 p.m.', 'https://tbcpagos.com/p/abcdefghjk');
    expect(m).toContain('3:45 p.m. sigue apartado hasta el lunes, 28 de septiembre, 1:45 p.m. Si ya lo pagaste');
    expect(m.endsWith('\nhttps://tbcpagos.com/p/abcdefghjk')).toBe(true);
    expect(m).not.toContain('..');
  });
});
