/**
 * Shared eval fixtures for the front-desk role.
 * A self-contained tenant so evals run without touching the DB.
 */

import type { TenantContext } from '../../../core/types.js';

/**
 * The fit filter from The Bot Crew's live `prompt_overrides.qualificationNotes`
 * (tenant 04385692-…), reproduced here so `fit-filter.eval.ts` can exercise it.
 *
 * ⚠️ THIS IS A COPY. The prompt itself lives in the DB — that's the platform's
 * config/code split, and the price of it is that this text can drift from
 * production without anything failing. **Edit the tenant and this constant in
 * the same change**, the same rule the docs carry. What the evals protect is
 * the RULE (chat-only → no demo; ambiguity → a question), so a small wording
 * drift is survivable; a rule that quietly disappears from one side is not.
 */
export const FIT_FILTER_SECTION = `# A quién le sirve esto (filtro único)
El sistema vive del CALENDARIO: su trabajo es convertir un lead en una CITA. Sirve a negocios que necesitan agendar, ya sea para:
- dar su servicio (clínica, dentista, estética, gym, spa, taller, bienes raíces), o
- una llamada de ventas o consulta donde se cierra el trato (agencias, consultoría, seguros, servicios B2B).

NO le sirve a un negocio donde la venta se cierra ahí mismo en el chat y nunca hay cita: tienda en línea, ropa, comida a domicilio, productos por catálogo, reventa. Ahí no hay nada que agendar — el sistema no cobra, no arma pedidos ni gestiona envíos.

Nunca descalifiques por SOSPECHA. Si te da esa impresión, haz UNA pregunta antes de concluir:
"Para ver si esto te sirve: tus clientes ¿agendan una cita o llamada contigo, o la compra se cierra ahí mismo por mensaje?"
Solo si responde claro que todo se cierra en el chat y que no hay citas, descalifica.

Cómo descalificar (cálido y directo, sin dejarlo mal):
1. Reconoce su negocio con respeto.
2. Dilo claro: el sistema agenda citas y en su caso no hay cita que agendar — no le vas a vender algo que no le va a servir.
3. Deja la puerta abierta: si más adelante maneja consultas, asesorías o citas, que te escriba.
4. NO llames startDemo. NO ofrezcas la sesión de 20 min.
5. Cierra el turno llamando updateConversationStatus con status "standby" y reason "no agenda citas".

Todo lo demás sigue igual: tamaño, giro, volumen de mensajes o presupuesto NUNCA descalifican. Este es el único filtro.

# Demo en vivo (lead magnet)
Si el lead llega pidiendo su demo:
1. Reúne conversando (no como formulario): nombre del negocio, giro, y sus 2-5 servicios principales.
2. En cuanto tengas nombre + giro + servicios Y confirmes que el negocio agenda citas, llama startDemo con esos datos.
3. No llames startDemo si el lead no vino por la demo, no quiere probarla, o su negocio no agenda citas.

# Si sí encaja
Ofrécele agendar una sesión de 20 min con Leo para mostrarle cómo funciona.`;

export const demoTenant: TenantContext = {
  tenantId: 't_demo',
  clientId: 'c_demo',
  ghlLocationId: 'loc_demo_0001',
  enabledRoles: ['front-desk'],
  enabledChannels: ['whatsapp', 'instagram', 'facebook'],
  testContactIds: null,
  triggerKeywords: null,
  demoOnKeywords: null,
  demoOffKeywords: null,
  keywordVariants: null,
  awaitingHumanTag: null,
  demoSessionsEnabled: false,
  config: {
    businessName: 'Clínica Demo',
    timezone: 'America/Mexico_City',
    tone: 'cálido, profesional y cercano',
    services: [
      { name: 'Consulta general', durationMin: 30, description: 'Primera valoración' },
      { name: 'Limpieza dental', durationMin: 45 },
    ],
    hours: {
      mon: [{ open: '09:00', close: '18:00' }],
      fri: [{ open: '09:00', close: '15:00' }],
    },
    calendars: { 'Consulta general': 'cal_demo_general', 'Limpieza dental': 'cal_demo_limpieza' },
    faq: [
      { q: '¿Aceptan seguro?', a: 'Trabajamos con las principales aseguradoras; confírmanos la tuya al agendar.' },
      { q: '¿Dónde están ubicados?', a: 'En el centro de la ciudad; te compartimos la ubicación al agendar.' },
    ],
    promptOverrides: {},
  },
};

/**
 * The Bot Crew's own tenant (the one that sells the platform), trimmed to what
 * the fit filter needs. `demoSessionsEnabled` stays FALSE on purpose: these
 * cases assert on which tools the model reaches for, and a false flag makes
 * startDemo short-circuit before it can touch the DB even if a mock slips.
 */
export const botCrewTenant: TenantContext = {
  ...demoTenant,
  tenantId: 't_botcrew',
  clientId: 'c_botcrew',
  ghlLocationId: 'loc_botcrew_0001',
  config: {
    businessName: 'The Bot Crew',
    timezone: 'America/Mexico_City',
    tone: 'directo, cálido, sin presión; como una persona real que conoce lo que hace',
    services: [{ name: 'Sesión de instalación', durationMin: 20, description: 'Llamada de 20 min con Leo' }],
    hours: { mon: [{ open: '09:00', close: '18:00' }], fri: [{ open: '09:00', close: '15:00' }] },
    calendars: { 'Sesión de instalación': 'cal_botcrew_sesion' },
    faq: [],
    promptOverrides: {
      identity:
        'Eres el asistente virtual de Leo, fundador de The Bot Crew. Atiendes a dueños de negocios por WhatsApp e Instagram. ' +
        'Tu misión: entender el negocio del prospecto, calificar si encaja con la oferta y — si califica — agendar una sesión de 20 min.',
      offering:
        '# Qué hace The Bot Crew\nInstala un agente de IA que responde a los leads que el negocio YA recibe, los califica y los AGENDA en su calendario. ' +
        'No es publicidad y no genera demanda: da atención inmediata para que ningún interesado se quede sin respuesta.',
      qualificationNotes: FIT_FILTER_SECTION,
    },
  },
};
