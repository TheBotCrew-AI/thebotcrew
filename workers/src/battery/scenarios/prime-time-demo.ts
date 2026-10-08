/**
 * Prime time reserved for paying services (0066) — the SHOWCASE, on a synthetic clinic.
 *
 * No client has this on yet, so the tenant here is invented ("Clínica Aura", medicina
 * estética) and the bundle is `offline`: it never reads Supabase, nothing touches a real
 * account. What it shows is the platform rule, which is code: a free valoración is offered
 * the off-peak slots first, gets the evening only when nothing else works, and a paying
 * treatment sees the evening from the start.
 *
 *   pnpm battery prime-time-demo && pnpm battery:render prime-time-demo
 */

import { demoTenant } from '../../roles/front-desk/evals/fixtures.js';
import type { TenantContext } from '../../core/types.js';
import type { TenantScenarios } from '../scenario.js';

const WEEKDAY = [{ open: '09:00', close: '20:00' }];

export const primeTimeDemoTenant: TenantContext = {
  ...demoTenant,
  tenantId: 't_prime_demo',
  clientId: 'c_prime_demo',
  ghlLocationId: 'loc_prime_demo_0001',
  config: {
    businessName: 'Clínica Aura',
    timezone: 'America/Mexico_City',
    tone: 'cálida, cercana y profesional; como una recepcionista con experiencia que conoce bien cada tratamiento',
    services: [
      { name: 'Valoración', durationMin: 30, description: 'Valoración gratuita con la doctora: revisa tu piel y te propone un plan.' },
      { name: 'Bótox', durationMin: 45, description: 'Aplicación de toxina botulínica. Desde $3,500 por zona.' },
      { name: 'Limpieza facial profunda', durationMin: 60, description: 'Limpieza facial profunda con hidratación. $1,200.' },
    ],
    hours: { mon: WEEKDAY, tue: WEEKDAY, wed: WEEKDAY, thu: WEEKDAY, fri: WEEKDAY, sat: [{ open: '09:00', close: '14:00' }] },
    calendars: { Valoración: 'cal_aura_valoracion', Bótox: 'cal_aura_botox', 'Limpieza facial profunda': 'cal_aura_limpieza' },
    faq: [
      { q: '¿Dónde están?', a: 'En Av. Reforma 120, col. Centro, a una cuadra del parque. Hay estacionamiento.' },
      { q: '¿La valoración tiene costo?', a: 'No, la valoración es gratuita y sin compromiso.' },
    ],
    promptOverrides: {
      identity: 'Eres Mariana, recepcionista de Clínica Aura (medicina estética). Atiendes por WhatsApp e Instagram.',
      qualificationNotes: `Flujo:
1. Saluda y pregunta qué le gustaría tratarse o qué la trae.
2. Si ya sabe qué tratamiento quiere (bótox, limpieza), ofrécele agendarlo directo con su precio.
3. Si no sabe o quiere que la revisen primero, ofrécele la valoración gratuita.
4. Agenda. Confirma día y hora y cierra.`,
      toolInstructions: {
        getAvailability:
          'Usa serviceName EXACTAMENTE como está en el catálogo: "Valoración", "Bótox" o "Limpieza facial profunda" (sin la duración). Ofrece exactamente DOS horarios, en un solo mensaje corto y sin lista con viñetas (por ejemplo: "Tengo el jueves a las 11:30 o el viernes a la 1:00, ¿cuál te queda mejor?"). Si el lead pidió una hora o un momento del día, los dos horarios que ofrezcas deben ser los más cercanos a eso de los que la herramienta devolvió. Usa EXACTAMENTE el texto del campo "label" de cada horario que menciones: no recalcules fechas, no traduzcas días y no inventes horarios.',
        bookAppointment:
          'Al confirmar, repite el día y la hora tal como vienen en el label y dile que le llega la confirmación por WhatsApp. Después de confirmar, cierra con calidez y ya no hagas más preguntas.',
      },
    },
    primeTime: {
      windows: [{ days: ['mon', 'tue', 'wed', 'thu', 'fri'], start: '17:00', end: '20:00' }],
      restrictedServices: ['Valoración'],
    },
  },
};

export const primeTimeDemo: TenantScenarios = {
  slug: 'prime-time-demo',
  ghlLocationId: primeTimeDemoTenant.ghlLocationId,
  fixture: primeTimeDemoTenant,
  offline: true,
  assistantName: 'Mariana',
  scenarios: [
    {
      id: 'valoracion-acepta-manana',
      title: 'Valoración gratuita — acepta un horario de mañana',
      shows: 'Pide la valoración gratis sin preferencia de hora. Solo ve horarios fuera de la tarde (5 a 8 p.m. está reservado) y agenda uno sin enterarse de que existe la regla.',
      lead: {
        name: 'Fernanda',
        phone: '+525512345678',
        channel: 'whatsapp',
        persona: `Tienes 34 años. Viste un anuncio de la clínica y quieres que te revisen la piel antes de decidir algo; sabes que hay una valoración gratis y eso es lo que quieres.
No tienes preferencia de horario: trabajas desde casa y cualquier hora te acomoda. Eliges el primer horario que te ofrezcan.
Si te preguntan tu nombre, lo das. Cuando te confirmen la cita, agradeces y terminas.`,
      },
      opener: 'Hola, vi que tienen valoración gratis, ¿cómo le hago para agendar?',
      maxTurns: 7,
      endWhen: { toolCalled: ['bookAppointment'] },
    },
    {
      id: 'valoracion-solo-tarde',
      title: 'Valoración gratuita — de plano solo puede en la tarde',
      shows: 'Pide la valoración gratis y quiere a las 6 p.m. Primero le ofrecen lo de fuera de la tarde; cuando dice que no puede en ninguno, se le abre la tarde y agenda. Nunca se le dice que hubo una excepción.',
      lead: {
        name: 'Paola',
        phone: '+525598765432',
        channel: 'whatsapp',
        persona: `Tienes 29 años, trabajas en oficina de 9 a 5 y sales a las 5:30. Quieres la valoración gratuita, pero SOLO puedes después de las 6 de la tarde entre semana; los sábados no puedes porque cuidas a tu mamá.
La primera vez que te ofrezcan horarios, pide directamente algo a las 6 o más tarde. Si te ofrecen horarios de mañana o mediodía, dices que no puedes, que trabajas, que de plano solo puedes de 6 en adelante. No cedes.
Cuando por fin te ofrezcan algo de 6 p.m. en adelante, eliges uno. Si te preguntan tu nombre, lo das. Cuando te confirmen la cita, agradeces y terminas.`,
      },
      opener: 'Hola! Quiero agendar la valoración gratuita, ¿tienen algo a las 6 de la tarde?',
      maxTurns: 9,
      endWhen: { toolCalled: ['bookAppointment'] },
    },
    {
      id: 'botox-tarde-directo',
      title: 'Bótox — pide la tarde y la tiene de entrada',
      shows: 'Ya sabe que quiere bótox (tratamiento pagado). Pide la tarde y se la ofrecen de inmediato: la regla no le aplica.',
      lead: {
        name: 'Lucía',
        phone: '+525511122233',
        channel: 'whatsapp',
        persona: `Tienes 42 años. Ya te has puesto bótox antes en otro lugar y quieres agendar directo, sin valoración. Prefieres saliendo del trabajo, después de las 5 de la tarde.
Si te preguntan qué quieres, dices bótox en frente y entrecejo. Si te ofrecen horarios de tarde, eliges uno. Si te preguntan tu nombre, lo das. Cuando te confirmen la cita, agradeces y terminas.`,
      },
      opener: 'Buenas tardes, quiero agendar bótox, de preferencia saliendo del trabajo como a las 6',
      maxTurns: 7,
      endWhen: { toolCalled: ['bookAppointment'] },
    },
  ],
};
