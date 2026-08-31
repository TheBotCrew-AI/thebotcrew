import { describe, it, expect } from 'vitest';
import { buildAppointmentTitle } from './appointment-title.js';

describe('buildAppointmentTitle', () => {
  it('joins name, treatment and campaign label', () => {
    expect(
      buildAppointmentTitle({
        contactName: 'Karla Mendoza',
        treatment: 'Bótox frente y entrecejo',
        serviceName: 'Consulta',
        campaignLabel: 'Jornada Bótox',
      }),
    ).toBe('Karla Mendoza — Bótox frente y entrecejo — Jornada Bótox');
  });

  it('falls back to the service name when no treatment was discussed', () => {
    expect(buildAppointmentTitle({ contactName: 'Karla', serviceName: 'Consulta' })).toBe('Karla — Consulta');
  });

  it('degrades to the bare service name with nothing else (pre-existing behavior)', () => {
    expect(buildAppointmentTitle({ serviceName: 'Consulta' })).toBe('Consulta');
  });

  it('omits the campaign suffix when there is no label', () => {
    expect(buildAppointmentTitle({ treatment: 'Bótox full face', serviceName: 'Consulta' })).toBe('Bótox full face');
  });

  it('treats blank strings as absent', () => {
    expect(
      buildAppointmentTitle({ contactName: '  ', treatment: '', serviceName: 'Consulta', campaignLabel: '  ' }),
    ).toBe('Consulta');
  });
});
