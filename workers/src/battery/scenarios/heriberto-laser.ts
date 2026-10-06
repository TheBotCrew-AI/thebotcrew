/**
 * Dr. Heriberto Valdivia — the laser campaigns (October 2026): one lead per ad, pinned to its
 * variant, opening the way the ad delivers it (GHL's headline line + the prefilled message).
 * Separate from the `heriberto` showcase so the client report stays one bundle per purpose.
 *
 *   pnpm battery heriberto-laser [--only lp4-manchas,lc7-oferta]
 */

import { heribertoTenant } from '../../roles/front-desk/evals/fixtures.js';
import type { TenantScenarios } from '../scenario.js';

const adOpener = (headline: string, prefill: string) => `*Headline:* ${headline}\n\n${prefill}`;

export const heribertoLaser: TenantScenarios = {
  slug: 'heriberto-laser',
  ghlLocationId: 'rfL7uM3c5mpfIUGxCR3C',
  fixture: heribertoTenant,
  assistantName: 'Sofía',
  scenarios: [
    {
      id: 'lp4-manchas',
      title: 'P4 — manchas que no se quitan con cremas',
      shows: 'Llega con curiosidad: Sofía no abre con el precio, entiende su caso y le presenta la evaluación.',
      lead: {
        name: 'Claudia',
        phone: '+526141110001',
        persona: `Tienes 41 años. Tienes manchas en las mejillas desde tu último embarazo, hace unos 5 años; has probado cremas despigmentantes sin resultado.
No conoces la clínica ni el precio. Contestas lo que te pregunten, en corto.
Cuando te expliquen el siguiente paso, preguntas cuánto cuesta. Si te parece razonable, aceptas agendar y eliges uno de los horarios.
Tu objetivo es dejar la evaluación agendada. Cuando te la confirmen, agradeces y terminas.`,
      },
      opener: adOpener('¿No se van las manchas?', 'Hola, tengo manchas que no se quitan con cremas y quiero saber si se pueden tratar'),
      promptVariant: 'lp4',
      maxTurns: 8,
      endWhen: { toolCalled: ['bookAppointment'] },
    },
    {
      id: 'lp5-acne',
      title: 'P5 — cicatrices de acné',
      shows: 'Pregunta cuánto puede mejorar y si pierde los $500 si no es candidata.',
      lead: {
        name: 'Andrea',
        phone: '+526141110002',
        persona: `Tienes 27 años. Tienes cicatrices de acné hundidas en las mejillas desde la prepa. Te las tapas con maquillaje.
Quieres saber cuánto pueden mejorar. Cuando te digan que hay una evaluación con costo, preguntas qué pasa con tu dinero si el láser no es para ti.
Si te convence la respuesta, agendas y eliges uno de los horarios.
Tu objetivo es dejar la evaluación agendada. Cuando te la confirmen, agradeces y terminas.`,
      },
      opener: adOpener('Tapar no es tratar', 'Hola, tengo cicatrices de acné y quiero saber cuánto pueden mejorar'),
      promptVariant: 'lp5',
      maxTurns: 8,
      endWhen: { toolCalled: ['bookAppointment'] },
    },
    {
      id: 'lp3-colageno',
      title: 'P3 — colágeno, piel cansada',
      shows: 'Edita el mensaje del anuncio. Sofía entiende qué quiere mejorar y la lleva a la evaluación.',
      lead: {
        name: 'Patricia',
        phone: '+526141110003',
        persona: `Tienes 48 años. Sientes la piel apagada, con líneas finas y poros más abiertos que antes. No sabes qué tratamiento te conviene.
Preguntas si duele. Después preguntas cuánto cuesta.
Si te gusta lo que escuchas, agendas y eliges uno de los horarios.
Tu objetivo es dejar la evaluación agendada. Cuando te la confirmen, agradeces y terminas.`,
      },
      opener: adOpener('No es cansancio', 'Hola, vi lo del colágeno, me puede ayudar? siento la piel muy apagada'),
      promptVariant: 'lp3',
      maxTurns: 8,
      endWhen: { toolCalled: ['bookAppointment'] },
    },
    {
      id: 'lc3-medico',
      title: 'C3 — quiere agendar con el médico',
      shows: 'Ya trae intención: Sofía resume la evaluación, pregunta qué quiere tratar y ofrece horarios.',
      lead: {
        name: 'Mónica',
        phone: '+526141110004',
        persona: `Tienes 35 años. Ya conoces el láser CO2 y quieres tratarte la textura y los poros de la cara.
Contestas qué quieres tratar en una línea y eliges uno de los horarios que te ofrezcan.
Tu objetivo es dejar la evaluación agendada. Cuando te la confirmen, agradeces y terminas.`,
      },
      opener: adOpener('¿Quién te lo aplica?', 'Hola, quiero agendar mi evaluación con el médico'),
      promptVariant: 'lc3',
      maxTurns: 6,
      endWhen: { toolCalled: ['bookAppointment'] },
    },
    {
      id: 'lc6-sin-riesgo',
      title: 'C6 — sus $500 están seguros',
      shows: 'Pregunta si puede empezar en dos meses: Sofía le explica el plazo de 14 días sin inventar nada.',
      lead: {
        name: 'Gabriela',
        phone: '+526141110005',
        persona: `Tienes 39 años. Quieres tratarte manchas y textura. Viajas mucho en las próximas semanas.
Antes de agendar preguntas si puedes hacer la evaluación ahora y empezar las sesiones en dos meses con el precio especial.
Con la respuesta, decides agendar la evaluación de todos modos y eliges uno de los horarios.
Tu objetivo es dejar la evaluación agendada. Cuando te la confirmen, agradeces y terminas.`,
      },
      opener: adOpener('Tus $500 están seguros', 'Hola, quiero agendar mi evaluación de láser'),
      promptVariant: 'lc6',
      maxTurns: 7,
      endWhen: { toolCalled: ['bookAppointment'] },
    },
    {
      id: 'lc7-oferta',
      title: 'C7 — precio especial de láser',
      shows: 'Viene por el precio: Sofía se lo explica completo, contesta cuánto sale el plan y una pregunta médica, y agenda.',
      lead: {
        name: 'Laura',
        phone: '+526141110006',
        persona: `Tienes 44 años. Viste la oferta del láser y quieres aprovecharla para unas cicatrices de acné.
Preguntas cuánto te saldría todo el tratamiento. Luego comentas que tomas isotretinoína desde hace un mes y preguntas si hay problema.
Si te ofrecen horarios, eliges uno.
Tu objetivo es dejar la evaluación agendada. Cuando te la confirmen, agradeces y terminas.`,
      },
      opener: adOpener('Precio especial láser', 'Hola, quiero agendar mi evaluación para el precio especial de láser'),
      promptVariant: 'lc7',
      maxTurns: 8,
      endWhen: { toolCalled: ['bookAppointment'] },
    },
    {
      id: 'i01-laser',
      title: 'i01 — llega por armonización y quiere láser',
      shows: 'Su depósito de $500 es su evaluación de láser: se descuenta de la primera sesión, sin el crédito de $1,000 ni el "al doble".',
      lead: {
        name: 'Sofía Ramírez',
        phone: '+526141110007',
        persona: `Tienes 36 años. Viste el anuncio de la Primera Visita de Armonización Facial, pero lo que te interesa es el láser CO2 para manchas y textura.
Preguntas cuánto cuesta el láser. Luego preguntas qué pasa con los $500 del depósito.
Si te convence, agendas y eliges uno de los horarios. Si te mandan una liga de pago, dices que ahorita la pagas y terminas.`,
      },
      opener: 'Hola, vi lo de la primera visita PLAN. Me interesa más el láser CO2, cuánto cuesta?',
      promptVariant: 'i01',
      maxTurns: 7,
      endWhen: { toolCalled: ['bookAppointment'] },
    },
  ],
};
