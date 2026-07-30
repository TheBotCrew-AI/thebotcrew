import { describe, it, expect } from 'vitest';
import type { DemoHandoff } from '../../core/types.js';
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

describe('buildFrontDeskInstructions — campaign prompt variants', () => {
  const variantCfg = () =>
    cfg({
      promptOverrides: { offering: 'Oferta base', qualificationNotes: 'Flujo base' },
      promptVariants: {
        'laser-promo': { offering: 'Promo de laser: primera sesión gratis' },
      },
    });

  it('applies the pinned variant, keeping unset fields from base', () => {
    const out = buildFrontDeskInstructions(variantCfg(), NOW, undefined, undefined, undefined, undefined, 'laser-promo');
    expect(out).toContain('Promo de laser: primera sesión gratis'); // variant offering
    expect(out).toContain('Flujo base');                            // base qualificationNotes survives
    expect(out).not.toContain('Oferta base');
  });

  it('uses base overrides when no variant is pinned or the key is unknown', () => {
    expect(buildFrontDeskInstructions(variantCfg(), NOW)).toContain('Oferta base');
    expect(
      buildFrontDeskInstructions(variantCfg(), NOW, undefined, undefined, undefined, undefined, 'gone'),
    ).toContain('Oferta base');
  });

  it('demo persona ignores the pinned variant', () => {
    const c = cfg({
      promptOverrides: { offering: 'Oferta base' },
      promptVariants: { 'laser-promo': { offering: 'Oferta variante' } },
      demoPromptOverrides: { identity: 'Persona demo', offering: 'Oferta demo' },
    });
    const out = buildFrontDeskInstructions(c, NOW, undefined, 'demo', undefined, undefined, 'laser-promo');
    expect(out).toContain('Oferta demo');
    expect(out).not.toContain('Oferta variante');
  });

  it('a variant can disable booking (strips the booking sections)', () => {
    const c = cfg({
      promptOverrides: {},
      promptVariants: { 'sin-agenda': { bookingEnabled: false } },
    });
    const withBooking = buildFrontDeskInstructions(c, NOW);
    const without = buildFrontDeskInstructions(c, NOW, undefined, undefined, undefined, undefined, 'sin-agenda');
    expect(withBooking).toContain('getAvailability');
    expect(without).not.toContain('# Agendar citas');
  });
});

describe('buildFrontDeskInstructions — golden rule is demo-aware', () => {
  it('normal persona keeps the STRICT rule (every real tenant, unchanged)', () => {
    const out = buildFrontDeskInstructions(cfg(), NOW);
    expect(out).toContain('# Regla de oro');
    expect(out).toContain('Solo afirma datos que estén en esta configuración');
    expect(out).not.toContain('modo demo');
  });

  it('demo persona allows general domain knowledge but still bans business-specific invention', () => {
    const c = cfg({ demoPromptOverrides: { identity: 'Demo persona' } });
    const out = buildFrontDeskInstructions(c, NOW, undefined, 'demo');
    expect(out).toContain('# Regla de oro (modo demo)');
    expect(out).toContain('conocimiento general del rubro');
    expect(out).toContain('NUNCA inventas son los datos ESPECÍFICOS');
    expect(out).not.toContain('Solo afirma datos que estén en esta configuración');
  });

  it('a variant-pinned (non-demo) conversation still gets the strict rule', () => {
    const c = cfg({ promptVariants: { promo: { offering: 'Promo' } } });
    const out = buildFrontDeskInstructions(c, NOW, undefined, undefined, undefined, undefined, 'promo');
    expect(out).toContain('Solo afirma datos que estén en esta configuración');
  });
});

describe('buildFrontDeskInstructions — demo closer (setter flow)', () => {
  const handoff: DemoHandoff = { reason: 'exhausted', businessName: 'Inner Beauty', businessType: 'MedSpa' };
  const closer = (h: DemoHandoff = handoff) =>
    buildFrontDeskInstructions(cfg(), NOW, undefined, undefined, undefined, undefined, undefined, h);

  it('renders only after a demo ends, never during the demo or in a normal turn', () => {
    expect(buildFrontDeskInstructions(cfg(), NOW)).not.toContain('CIERRE DE DEMO');
    const demoCfg = cfg({ demoPromptOverrides: { identity: 'Demo' } });
    // usingDemo wins: the closer block must not leak into the roleplay turn.
    expect(buildFrontDeskInstructions(demoCfg, NOW, undefined, 'demo', undefined, undefined, undefined, handoff))
      .not.toContain('CIERRE DE DEMO');
    expect(closer()).toContain('CIERRE DE DEMO');
  });

  it("carries the lead's business into the soft pitch", () => {
    const out = closer();
    expect(out).toContain('"Inner Beauty" (MedSpa)');
    expect(out).toContain('¿Te serviría algo así en Inner Beauty, respondiendo así a cada cliente 24/7?');
  });

  it('branches: yes → name + qualify + real booking; no → discovery with pain and dream framing', () => {
    const out = closer();
    expect(out).toContain('Si dice que SÍ');
    expect(out).toContain('¿Con quién tengo el gusto?');
    expect(out).toContain('getAvailability');
    expect(out).toContain('Esa cita SÍ es real');
    expect(out).toContain('Si dice que NO');
    expect(out).toContain('menos de 5 minutos');
    expect(out).toContain('sin contestar');           // pain
    expect(out).toContain('cómo se vería su semana'); // dream outcome
    expect(out).toContain('updateConversationStatus(standby)');
  });

  it('keeps the one-question-per-message discipline explicit', () => {
    expect(closer()).toContain('UNA pregunta por mensaje');
  });

  it('degrades gracefully when the session carried no business name', () => {
    const out = closer({ reason: 'expired', businessName: undefined, businessType: undefined });
    expect(out).toContain('su negocio');
    expect(out).toContain('pasó su tiempo límite');
    expect(out).not.toContain('undefined');
  });
});
