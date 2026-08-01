import { describe, it, expect } from 'vitest';
import type { DemoHandoff } from '../../core/types.js';
import { parseFrontDeskConfig } from './config.js';
import { buildDemoEndAnnouncement, buildDemoStartAnnouncement, buildFrontDeskInstructions } from './prompt.js';

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

  describe('lookupFaq is announced outside the flow', () => {
    // Regression: the tool was named only inside the built-in `# Tu objetivo` list, which a
    // tenant's own qualificationNotes replaces — so every custom-flow tenant lost it and the
    // agent answered "no tengo ese dato" to questions the FAQ answers verbatim.
    it('renders for a tenant with a CUSTOM flow (where it used to disappear)', () => {
      const out = buildFrontDeskInstructions(
        cfg({ faq: [{ q: 'a', a: 'b' }], promptOverrides: { qualificationNotes: 'MI FLUJO' } }),
        NOW,
      );
      expect(out).toContain('MI FLUJO');
      expect(out).toContain('# Preguntas frecuentes');
      expect(out).toContain('lookupFaq');
    });

    it('states how many answers exist, so the model knows there is something to look up', () => {
      const twoFaqs = cfg({ faq: [{ q: 'a', a: 'b' }, { q: 'c', a: 'd' }] });
      expect(buildFrontDeskInstructions(twoFaqs, NOW)).toContain('Hay 2 respuestas oficiales');
    });

    it('is absent when the tenant has no FAQ at all', () => {
      expect(buildFrontDeskInstructions(cfg({ faq: [] }), NOW)).not.toContain('# Preguntas frecuentes');
    });

    it('is suppressed in demo mode — the FAQ holds OUR answers, not the roleplayed business\'s', () => {
      const out = buildFrontDeskInstructions(
        cfg({ faq: [{ q: 'a', a: 'b' }], demoPromptOverrides: { identity: 'Otra clínica' } }),
        NOW,
        undefined,
        'demo',
      );
      expect(out).not.toContain('# Preguntas frecuentes');
    });
  });

  describe('houseRules — tenant rules that outrank the campaign flow', () => {
    const RULES = 'Solo servimos a negocios que agendan citas.';
    const withRules = (raw: Record<string, unknown> = {}) =>
      cfg({ ...raw, promptOverrides: { houseRules: RULES, ...(raw.promptOverrides as object) } });

    it('renders as its own section, labelled as outranking the flow', () => {
      const out = buildFrontDeskInstructions(withRules(), NOW);
      expect(out).toContain('# Reglas de casa — mandan sobre el flujo de arriba');
      expect(out).toContain(RULES);
    });

    it('renders AFTER the flow, so a campaign script cannot bury it', () => {
      const out = buildFrontDeskInstructions(
        withRules({ promptOverrides: { qualificationNotes: 'MI FLUJO' } }),
        NOW,
      );
      expect(out.indexOf(RULES)).toBeGreaterThan(out.indexOf('MI FLUJO'));
    });

    it('survives a pinned campaign variant that replaces the whole flow', () => {
      const out = buildFrontDeskInstructions(
        withRules({
          promptOverrides: { qualificationNotes: 'FLUJO BASE' },
          promptVariants: { promo: { qualificationNotes: 'FLUJO DE CAMPAÑA' } },
        }),
        NOW,
        undefined, // contactPhone
        undefined, // activeRole
        undefined, // contactName
        undefined, // activeAppointment
        'promo',   // promptVariant
      );
      expect(out).toContain('FLUJO DE CAMPAÑA');
      expect(out).not.toContain('FLUJO BASE');
      expect(out).toContain(RULES); // the campaign replaced the flow, NOT the house rules
    });

    it('is suppressed in demo mode — rules about OUR business make no sense in the roleplay', () => {
      const out = buildFrontDeskInstructions(
        withRules({ demoPromptOverrides: { identity: 'Recepcionista de otra clínica' } }),
        NOW,
        undefined, // contactPhone
        'demo',    // activeRole
      );
      expect(out).not.toContain(RULES);
      expect(out).not.toContain('# Reglas de casa');
    });

    it('no houseRules configured → no section at all', () => {
      expect(buildFrontDeskInstructions(cfg(), NOW)).not.toContain('# Reglas de casa');
    });
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
    // Demo formatting: chat-length replies, no brochure dumps (1 emoji allowed).
    expect(out).toContain('UN solo mensaje por turno');
    expect(out).toContain('PROHIBIDO: listas');
    expect(out).toContain('Máximo 1 emoji');
  });

  it('the strict no-emoji/no-list formatting stays for non-demo personas', () => {
    const out = buildFrontDeskInstructions(cfg(), NOW);
    expect(out).toContain('Sin listas. Sin negritas. Sin emojis');
    expect(out).not.toContain('UN solo mensaje por turno');
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

  // The most common objection on the way out of a demo, and the easiest to convert:
  // the assistant "no sabía" things it was never given. The closer must be able to
  // explain the gap and what closes it, instead of apologising.
  it('knows how to answer "el asistente no sabía cosas de mi negocio"', () => {
    const out = closer();
    expect(out).toContain('no sabía');
    expect(out).toMatch(/se entrena con TODA su información/i);
    expect(out).toMatch(/catálogo completo/i);
    // And it must not over-promise: training is bounded by what the business hands over.
    expect(out).toMatch(/se entrena con lo que ELLOS entreguen/i);
  });

  it("carries the lead's business into the soft pitch", () => {
    const out = closer();
    expect(out).toContain('"Inner Beauty" (MedSpa)');
    expect(out).toContain('¿Te serviría tener esto en Inner Beauty, contestando así a cada cliente 24/7?');
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

describe('buildFrontDeskInstructions — demo conversational variety', () => {
  const demo = () =>
    buildFrontDeskInstructions(cfg({ demoPromptOverrides: { identity: 'Recepción' } }), NOW, undefined, 'demo');

  it('bans repeating the same closing question and offers alternative angles', () => {
    const out = demo();
    expect(out).toContain('NUNCA repitas la misma pregunta de cierre');
    expect(out).toContain('¿te acomoda mejor entre semana o el sábado?');
    expect(out).toContain('¿mañana o tarde te funciona mejor?');
    expect(out).toContain('A veces contesta y ya, sin cierre');
  });

  it('tells it to stop asking once intent is clear', () => {
    expect(demo()).toContain('deja de preguntarle si quiere');
  });

  it('never renders for a non-demo persona (real tenants unaffected)', () => {
    const out = buildFrontDeskInstructions(cfg(), NOW);
    expect(out).not.toContain('Cómo llevas la conversación (demo)');
    expect(out).toContain('# Cuándo actualizar el estado de la conversación');
  });
});

describe('buildFrontDeskInstructions — closer announces the handover clearly', () => {
  const full: DemoHandoff = {
    reason: 'exhausted',
    businessName: 'SkinBeauty',
    businessType: 'med spa',
    leadName: 'Leo',
    services: ['HydraFacial', 'Botox'],
    booked: true,
  };
  const closer = (h: DemoHandoff = full) =>
    buildFrontDeskInstructions(cfg(), NOW, undefined, undefined, undefined, undefined, undefined, h);

  it('makes announcing the end of the demo mandatory and shows how', () => {
    const out = closer();
    expect(out).toContain('AVISA que terminó. Es obligatorio');
    expect(out).toContain('NO sabe que la prueba acabó');
    expect(out).toContain('Hasta aquí llega la demo');
    expect(out).toContain('Todo eso lo contestó el asistente de SkinBeauty');
  });

  it('forbids the exact failure seen live: pitching without announcing, or staying in character', () => {
    const out = closer();
    expect(out).toContain('PROHIBIDO en ese primer mensaje');
    expect(out).toContain('saltar directo a proponer la llamada sin antes avisar que la demo terminó');
  });

  it('carries what intake already learned so nothing is asked twice', () => {
    const out = closer();
    expect(out).toContain('Se llama Leo — ya te lo dijo, NO se lo vuelvas a preguntar');
    expect(out).toContain('HydraFacial, Botox');
    expect(out).toContain('llegó hasta AGENDAR una cita de prueba');
    expect(out).toContain('Solo si NO sabes su nombre');
  });

  it('overrides the tenant flow above it, and handles a bare handoff', () => {
    expect(closer()).toContain('Esta sección MANDA sobre cualquier otro flujo');
    const bare = closer({ reason: 'expired' });
    expect(bare).toContain('Solo que probó la demo de su negocio');
    expect(bare).toContain('tu negocio');
    expect(bare).not.toContain('undefined');
  });
});

describe('buildFrontDeskInstructions — closer replaces the tenant flow (the "¿con quién tengo el gusto?" bug)', () => {
  const handoff: DemoHandoff = { reason: 'exhausted', businessName: 'BeautyFull', leadName: 'Leo', booked: true };
  // A tenant whose own flow opens by greeting and asking for the name — exactly
  // what won over the closer section on 2026-07-30.
  const tenantFlow = () =>
    cfg({ promptOverrides: { qualificationNotes: '# Mi flujo\n1. Saluda y pregunta ¿con quién tengo el gusto?' } });
  const closer = () =>
    buildFrontDeskInstructions(tenantFlow(), NOW, undefined, undefined, undefined, undefined, undefined, handoff);

  it("suppresses the tenant's qualification flow entirely while closing", () => {
    expect(buildFrontDeskInstructions(tenantFlow(), NOW)).toContain('¿con quién tengo el gusto?'); // normal turn keeps it
    expect(closer()).not.toContain('# Mi flujo');
  });

  it('states outright that this is not a new conversation', () => {
    const out = closer();
    expect(out).toContain('ESTO NO ES UNA CONVERSACIÓN NUEVA');
    expect(out).toContain('NUNCA saludes como si fuera la primera vez');
    expect(out).toContain('NUNCA le vuelvas a pedir su nombre');
    expect(out).toContain('Ignora cualquier flujo de bienvenida');
  });

  it('distinguishes the first post-demo message from later ones', () => {
    const out = closer();
    expect(out).toContain('Si es tu PRIMER mensaje después de la demo');
    expect(out).toContain('Si YA avisaste');
    expect(out).toContain('No lo repitas');
  });

  it('handles a lead-closed demo without claiming it ran out', () => {
    const out = buildFrontDeskInstructions(
      cfg(), NOW, undefined, undefined, undefined, undefined, undefined,
      { reason: 'closed', businessName: 'X' },
    );
    expect(out).toContain('El lead cerró la demo él mismo');
  });
});

describe('buildDemoStartAnnouncement (deterministic rules of the game)', () => {
  it('says who answers next, how to write, and how to get out', () => {
    const out = buildDemoStartAnnouncement('Clínica Sonrisa', 'demo off');
    expect(out).toContain('ya no te respondo yo');
    expect(out).toContain('para Clínica Sonrisa');
    expect(out).toContain('como si fueras un cliente tuyo');
    expect(out).toContain('Escribe "demo off"');
    expect(out).toContain('\n\n'); // splits into short WhatsApp messages
  });

  // Leads finished the demo annoyed that the assistant "no sabía" things about their own
  // catalog — which it cannot know, having been built from three facts a minute earlier.
  it('sets the expectation about what the demo knows, and points at the real install', () => {
    const out = buildDemoStartAnnouncement('Clínica Sonrisa', 'demo off');
    expect(out).toMatch(/solo sabe lo que me contaste/i);
    expect(out).toMatch(/se entrena con TODA tu información/i);
    // It must land AFTER the invitation to write, so it never reads as "don't bother".
    expect(out.indexOf('solo sabe lo que me contaste')).toBeGreaterThan(
      out.indexOf('como si fueras un cliente tuyo'),
    );
  });

  it('omits the exit line when the tenant configured no off-keyword — never promise a dead word', () => {
    const out = buildDemoStartAnnouncement('Clínica Sonrisa', undefined);
    expect(out).not.toContain('salir de la demo');
    expect(out).toContain('ya no te respondo yo'); // the rest still lands
  });

  it('falls back to a generic business name rather than printing nothing', () => {
    expect(buildDemoStartAnnouncement(undefined, 'demo off')).toContain('para tu negocio');
    expect(buildDemoStartAnnouncement('   ', 'demo off')).toContain('para tu negocio');
  });

  it('ignores a blank off-keyword the same as a missing one', () => {
    expect(buildDemoStartAnnouncement('X', '   ')).not.toContain('Escribe');
  });
});

describe('buildDemoEndAnnouncement (deterministic handover)', () => {
  it('announces the end, names the business, and asks the soft question', () => {
    const out = buildDemoEndAnnouncement({ reason: 'exhausted', businessName: 'BeautyFull', leadName: 'Leo' });
    expect(out).toContain('Leo, hasta aquí llega la demo');
    expect(out).toContain('el asistente que armé para BeautyFull');
    expect(out).toContain('¿Te serviría tenerlo en BeautyFull contestando así a cada cliente, 24/7?');
    expect(out).toContain('\n\n'); // splits into two short WhatsApp messages
  });

  it('uses the booking as proof when the lead booked inside the demo', () => {
    const booked = buildDemoEndAnnouncement({ reason: 'exhausted', businessName: 'X', booked: true });
    expect(booked).toContain('hasta te agendó la cita');
    const notBooked = buildDemoEndAnnouncement({ reason: 'exhausted', businessName: 'X' });
    expect(notBooked).not.toContain('te agendó la cita');
  });

  it('says so when the demo expired, and degrades without a business name', () => {
    const expired = buildDemoEndAnnouncement({ reason: 'expired' });
    expect(expired).toContain('se cerró por tiempo');
    expect(expired).toContain('tu negocio');
    expect(expired).not.toContain('undefined');
  });

  it('stays chat-length (no brochure)', () => {
    const out = buildDemoEndAnnouncement({ reason: 'exhausted', businessName: 'BeautyFull', leadName: 'Leo', booked: true });
    expect(out.length).toBeLessThan(320);
  });
});

describe('buildFrontDeskInstructions — demo on FB/IG (no phone on the contact)', () => {
  const demoCfg = () => cfg({ demoPromptOverrides: { identity: 'Recepción demo', bookingEnabled: true } });

  it('the demo never asks for a WhatsApp number (the simulated booking discards it)', () => {
    const out = buildFrontDeskInstructions(demoCfg(), NOW, undefined, 'demo');
    expect(out).not.toContain('# Número para confirmación y recordatorios');
    expect(out).not.toContain('pídele su WhatsApp');
  });

  it('a normal FB/IG turn still asks for it — that booking is real', () => {
    const out = buildFrontDeskInstructions(cfg(), NOW, undefined);
    expect(out).toContain('No tenemos número de WhatsApp');
  });

  it('the closer after a demo still asks for it', () => {
    const out = buildFrontDeskInstructions(
      cfg(), NOW, undefined, undefined, undefined, undefined, undefined,
      { reason: 'booked', businessName: 'X', booked: true },
    );
    expect(out).toContain('No tenemos número de WhatsApp');
  });
});
