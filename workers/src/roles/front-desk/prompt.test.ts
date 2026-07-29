import { describe, it, expect } from 'vitest';
import { parseFrontDeskConfig } from './config.js';
import { buildFrontDeskInstructions } from './prompt.js';

const cfg = (raw: Record<string, unknown> = {}) =>
  parseFrontDeskConfig({
    businessName: 'Demo',
    timezone: 'America/Mexico_City',
    tone: null,
    services: [{ name: 'Corte', durationMin: 30, description: 'clásico' }],
    hours: { mon: [{ open: '09:00', close: '18:00' }], sat: [{ open: '09:00', close: '13:00' }] },
    calendars: { Corte: 'cal1' },
    faq: [],
    promptOverrides: {},
    ...raw,
  } as never);

const NOW = '2026-07-02T10:00:00';

describe('buildFrontDeskInstructions', () => {
  it('default identity + services + grouped hours', () => {
    const out = buildFrontDeskInstructions(cfg(), NOW);
    expect(out).toContain('recepcionista virtual de "Demo"');
    expect(out).toContain('- Corte (30 min) — clásico');
    expect(out).toContain('Lunes: 09:00–18:00');
    expect(out).toContain('Sábado: 09:00–13:00');
    expect(out).toContain('# Tu objetivo'); // default flow present
  });

  it('collapses identical daily schedules into "Todos los días"', () => {
    const out = buildFrontDeskInstructions(cfg({ hours: { mon: [{ open: '09:00', close: '18:00' }], tue: [{ open: '09:00', close: '18:00' }] } }), NOW);
    expect(out).toContain('Todos los días: 09:00–18:00');
  });

  it('booking horizon → adds the clamp line', () => {
    const out = buildFrontDeskInstructions(cfg({ bookingHorizonDays: 7 }), NOW);
    expect(out).toContain('Solo puedes agendar dentro de los próximos 7 días');
  });

  it('reminder section reflects whether we already have a phone', () => {
    expect(buildFrontDeskInstructions(cfg(), NOW, '+5216641234567')).toContain('Ya tenemos el número del lead');
    expect(buildFrontDeskInstructions(cfg(), NOW, undefined)).toContain('No tenemos número de WhatsApp');
  });

  it('renders the contact-name section only when a name is passed', () => {
    expect(buildFrontDeskInstructions(cfg(), NOW, undefined, undefined, 'Gimnasio X')).toContain('# Nombre del contacto');
    expect(buildFrontDeskInstructions(cfg(), NOW, undefined, undefined, 'Gimnasio X')).toContain('Gimnasio X');
    expect(buildFrontDeskInstructions(cfg(), NOW)).not.toContain('# Nombre del contacto');
  });

  it('renders the existing-appointment guard only when an active appointment is passed', () => {
    const withAppt = buildFrontDeskInstructions(cfg(), NOW, undefined, undefined, undefined, {
      startTime: '2026-07-04T14:30:00-07:00',
      service: 'Corte',
    });
    expect(withAppt).toContain('# Este contacto YA tiene una cita agendada');
    expect(withAppt).toContain('de "Corte"');
    // Label is formatted in the tenant tz (America/Mexico_City = -06:00 → 3:30 p.m.).
    expect(withAppt).toContain('3:30');
    expect(withAppt).toContain('NUNCA digas que esa hora "ya no está libre"');
    // No active appointment → section absent.
    expect(buildFrontDeskInstructions(cfg(), NOW)).not.toContain('# Este contacto YA tiene una cita agendada');
  });

  it('custom qualificationNotes replaces the default flow', () => {
    const out = buildFrontDeskInstructions(cfg({ promptOverrides: { qualificationNotes: 'MI FLUJO PERSONALIZADO' } }), NOW);
    expect(out).toContain('MI FLUJO PERSONALIZADO');
    expect(out).not.toContain('# Tu objetivo');
  });

  describe('bookingEnabled = false (tenant books by hand)', () => {
    const noBooking = () => cfg({ promptOverrides: { bookingEnabled: false } });

    it('strips every booking section from the base prompt', () => {
      const out = buildFrontDeskInstructions(noBooking(), NOW);
      expect(out).not.toContain('# Secuencia para agendar');
      expect(out).not.toContain('# Disponibilidad (regla estricta)');
      expect(out).not.toContain('# Reagendar o cancelar una cita');
      expect(out).not.toContain('# Después de agendar');
    });

    it('replaces them with the hand-off-to-a-human rules', () => {
      const out = buildFrontDeskInstructions(noBooking(), NOW);
      expect(out).toContain('# Las citas las agenda una persona');
      expect(out).toContain('updateConversationStatus(handed_off)');
      expect(out).toContain('NUNCA llames getAvailability');
    });

    it('leaves no instruction to call getAvailability anywhere', () => {
      // The whole point of the flag: a leftover "llama getAvailability" would contradict
      // the tenant's own rules and is exactly how the bot ends up inventing a slot.
      const out = buildFrontDeskInstructions(noBooking(), NOW);
      expect(out).not.toMatch(/llama getAvailability/);
    });

    it('drops the booking-horizon line, which only means anything when booking', () => {
      const out = buildFrontDeskInstructions(cfg({ bookingHorizonDays: 7, promptOverrides: { bookingEnabled: false } }), NOW);
      expect(out).not.toContain('Solo puedes agendar dentro de los próximos 7 días');
    });

    it('stops asking for a WhatsApp number it has no way to store', () => {
      // The number is only ever persisted as a bookAppointment argument.
      const out = buildFrontDeskInstructions(noBooking(), NOW, undefined);
      expect(out).not.toContain('No tenemos número de WhatsApp');
      expect(out).not.toContain('# Número para confirmación y recordatorios');
    });

    it('suppresses the existing-appointment section', () => {
      const out = buildFrontDeskInstructions(noBooking(), NOW, undefined, undefined, undefined, {
        startTime: '2026-07-03T17:00:00-06:00',
        service: 'Corte',
      });
      expect(out).not.toContain('# Este contacto YA tiene una cita agendada');
    });

    it('splits the request into two turns and forbids closing on a question', () => {
      // The 2026-07-29 dead end: the bot asked "¿mañana o tarde?" and set a terminal
      // state in the same turn, so the lead's answer hit a muted bot.
      const out = buildFrontDeskInstructions(noBooking(), NOW);
      expect(out).toContain('TURNO 1');
      expect(out).toContain('TURNO 2');
      expect(out).toContain('NUNCA llames flagAwaitingHuman en un turno donde le haces una pregunta');
    });

    it('routes the request through flagAwaitingHuman, not handed_off', () => {
      const out = buildFrontDeskInstructions(noBooking(), NOW);
      expect(out).toContain('flagAwaitingHuman');
      expect(out).toContain('NO uses updateConversationStatus(handed_off) para esto');
    });

    it('tells the agent it may keep answering after flagging', () => {
      // standby does not suppress, so questions must still get answered.
      const out = buildFrontDeskInstructions(noBooking(), NOW);
      expect(out).toContain('CONTÉSTALE con normalidad');
      expect(out).toContain('No estás bloqueada');
    });

    it('defaults to booking ENABLED when the flag is absent (no tenant is affected)', () => {
      const out = buildFrontDeskInstructions(cfg(), NOW);
      expect(out).toContain('# Secuencia para agendar');
      expect(out).not.toContain('# Las citas las agenda una persona');
    });
  });

  it('demo mode uses the demo persona overrides', () => {
    const out = buildFrontDeskInstructions(
      cfg({ demoPromptOverrides: { identity: 'SOY SOFÍA DE LA CLÍNICA', toolInstructions: {} } }),
      NOW,
      undefined,
      'demo',
    );
    expect(out).toContain('SOY SOFÍA DE LA CLÍNICA');
    expect(out).toContain('emojis'); // demo formatting note allows emojis
  });
});
