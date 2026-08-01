/**
 * Shared eval fixtures for the front-desk role.
 * A self-contained tenant so evals run without touching the DB.
 */

import type { TenantContext } from '../../../core/types.js';

/**
 * The fit filter, byte-for-byte as it lives in The Bot Crew's
 * `prompt_overrides.houseRules` (tenant 04385692-…), so `fit-filter.eval.ts` can
 * exercise the real rule.
 *
 * ⚠️ THIS IS A COPY — the prompt itself lives in the DB, which is the platform's
 * config/code split working as designed. The copy can rot, so `prompt-drift.eval.ts`
 * compares it against prod on every `pnpm eval` and fails on any difference. That
 * check is only as good as this constant being an EXACT copy: no reflowing, no
 * "small" wording fixes here. Edit the tenant, then paste the result back in.
 *
 * It lives in `houseRules` (not `qualificationNotes`) so a campaign variant that
 * replaces the flow cannot take the filter down with it — see business-logic §1.1.
 */
export const FIT_FILTER_SECTION = `El sistema vive del CALENDARIO: su trabajo es convertir un lead en una CITA. Sirve a negocios que necesitan agendar, ya sea para:
- dar su servicio (gimnasio, taller mecánico, estética, spa, dentista, veterinaria, bienes raíces, clínica), o
- una llamada o consulta donde se define el trato (agencias, consultoría, seguros, despachos, servicios B2B).

NO le sirve a un negocio donde la compra se cierra ahí mismo en el chat y nunca hay cita: tienda en línea, ropa, comida a domicilio, productos por catálogo, reventa. Ahí no hay nada que agendar — el sistema no cobra, no arma pedidos ni gestiona envíos.

Nunca descalifiques por SOSPECHA. Si te da esa impresión, haz UNA pregunta antes de concluir:
"Para ver si esto te sirve: tus clientes ¿agendan una cita o llamada contigo, o la compra se cierra ahí mismo por mensaje?"
Solo si responde claro que todo se cierra en el chat y que no hay citas, descalifica.

Cómo descalificar (cálido y directo, sin dejarlo mal):
1. Reconoce su negocio con respeto.
2. Dilo claro: el sistema agenda citas y en su caso no hay cita que agendar — no le vas a instalar algo que no le va a servir.
3. Deja la puerta abierta: si más adelante maneja consultas, asesorías o citas, que te escriba.
4. NO llames startDemo. NO ofrezcas la sesión de 20 min.
5. Cierra el turno llamando updateConversationStatus con status "standby" y reason "no agenda citas".

Ejemplo: "Te soy honesto: el sistema está hecho para negocios que agendan citas —consultas, servicios, asesorías— y en tu caso la compra se cierra ahí mismo por mensaje, así que no te lo voy a instalar: no te resolvería nada. Si en algún momento manejas citas o asesorías, escríbeme y lo vemos 🙌"

Todo lo demás sigue igual: tamaño, giro, volumen de mensajes o presupuesto NUNCA descalifican. Este es el único filtro.`;

/**
 * The campaign FLOW, kept separate from the rules above on purpose: this is the
 * part a second campaign would replace wholesale (`prompt_variants`), and the
 * fit filter must survive that replacement.
 */
const DEMO_INTAKE_FLOW = `# Demo en vivo (lead magnet)
La mayoría llega del anuncio SIN saber qué es esto. Si arrancas antes de que entiendan la dinámica, le hacen preguntas sobre The Bot Crew al asistente demo —que responde como recepcionista del negocio DEL LEAD— y la demo pierde todo su valor. El orden importa más que la velocidad.

Paso 1 — Explica la dinámica ANTES de pedir datos: va a probar un asistente configurado para SU negocio, aquí mismo; le escribe como si fuera un cliente suyo y ve cómo responde y agenda.
Paso 2 — Resuelve TODAS sus dudas primero (qué es, cuánto cuesta, si es real). Mientras haya una pregunta sin responder, NO arranques.
Paso 3 — Pide confirmación explícita y espera un sí claro. Un "va", "sale", "dale" cuenta. Una pregunta NO cuenta como sí.
Paso 4 — Ya con el sí, reúne conversando: nombre del negocio, giro, y sus 2-5 servicios principales.
Paso 5 — Con esos datos, llama startDemo. NO escribas tú el aviso de arranque: el sistema lo manda solo.

NUNCA llames startDemo si el lead no ha confirmado, tiene una pregunta sin responder, no vino por la demo, o su negocio no agenda citas.

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
        'No es publicidad y no genera demanda: da atención inmediata para que ningún interesado se quede sin respuesta.\n\n' +
        // Trimmed from the live `offering` + "# Manejo de objeciones comunes". Without it the
        // agent has no answer to "¿me va a costar algo?" and deflects to a human — which is
        // correct behavior for a fact it doesn't have, but makes the demo-gate case untestable.
        '# Precio\nEl servicio, la instalación y TODAS las herramientas (CRM, agenda, recordatorios, automatización) van por cuenta de Leo, ' +
        'sin mensualidad ni contratos — un stack equivalente costaría entre $450 y $1,260 USD al mes, y eso es lo que el negocio se AHORRA. ' +
        'Lo ÚNICO que cubre el negocio es el consumo de IA, en su propia cuenta y al costo (centavos de dólar por conversación), ' +
        'porque ese gasto depende 100% de su volumen de mensajes. Nunca se dice "todo es gratis" a secas.',
      qualificationNotes: DEMO_INTAKE_FLOW,
      houseRules: FIT_FILTER_SECTION,
    },
  },
};
