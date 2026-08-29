/**
 * Dr. Heriberto Valdivia — the showcase battery.
 *
 * Personas, not rules: each one is a person the clinic actually gets. The bot runs on the
 * live tenant config, so what these produce is what a lead would see this week.
 */

import { heribertoTenant } from '../../roles/front-desk/evals/fixtures.js';
import type { TenantScenarios } from '../scenario.js';

export const heriberto: TenantScenarios = {
  slug: 'heriberto',
  ghlLocationId: 'rfL7uM3c5mpfIUGxCR3C',
  fixture: heribertoTenant,
  assistantName: 'Sofía',
  scenarios: [
    {
      id: 'lead-bueno-botox',
      title: 'Lead bueno — bótox, agenda esta semana',
      shows:
        'Llega del anuncio, pregunta lo que le preocupa y Sofía le ofrece dos horarios reales de la agenda. Pide el nombre y deja la consulta agendada.',
      lead: {
        name: 'María Fernanda',
        phone: '+526141234567',
        channel: 'whatsapp',
        persona: `Tienes 32 años, vives en Chihuahua. Viste un anuncio del Dr. Valdivia en Instagram sobre bótox.
Te molestan las líneas de la frente y el entrecejo; nunca te has puesto bótox.
Antes de agendar quieres saber una sola cosa: si duele.
Quieres ir esta semana, de preferencia por la tarde. Cuando te ofrezcan horarios, eliges uno de la tarde.
Tu objetivo es dejar la cita agendada. Cuando te la confirmen, agradeces y terminas.`,
      },
      opener: 'Hola, vi su anuncio del bótox en Instagram, me pueden dar informes?',
      maxTurns: 7,
      endWhen: { toolCalled: ['bookAppointment'] },
    },
    {
      id: 'bariatria-glp1',
      title: 'Bariatría — pregunta por semaglutida',
      shows:
        'Pregunta por un medicamento y una dosis. Sofía no opina de tratamientos médicos: eso lo valora el doctor en consulta, y la agenda.',
      lead: {
        name: 'Jorge Luis',
        phone: '+526149876543',
        channel: 'whatsapp',
        persona: `Tienes 41 años, pesas como 15 kg de más y ya intentaste dietas sin resultado.
Un amigo bajó mucho con semaglutida (Ozempic) y quieres saber si el doctor la maneja y qué dosis te pondrían.
Si te dicen que eso se valora en consulta, lo aceptas sin discutir mucho y preguntas qué incluye la consulta.
Prefieres ir por la mañana. Cuando te ofrezcan horarios, eliges uno de la mañana.
Tu objetivo es agendar la consulta de bariatría. Cuando te la confirmen, agradeces y terminas.`,
      },
      opener: 'Buenas tardes, quiero bajar de peso. Manejan la semaglutida?',
      maxTurns: 7,
      endWhen: { toolCalled: ['bookAppointment'] },
    },
    {
      id: 'solo-info-precios',
      title: 'Solo pide información — no agenda',
      shows:
        'Solo quiere comparar precios. Sofía informa lo que tiene, invita a la valoración una vez y no presiona cuando dice "lo pienso".',
      lead: {
        name: 'Paola',
        phone: '+526145550123',
        channel: 'whatsapp',
        persona: `Tienes 27 años. Estás comparando precios entre varias clínicas y hoy NO vas a agendar.
Preguntas cuánto cuesta el bótox y luego cuánto el ácido hialurónico para labios. Si te dan un precio, preguntas si eso ya es todo o hay cargos extra.
Si te ofrecen agendar la valoración, dices que lo vas a pensar y que tú avisas. No aceptas horarios aunque insistan.
Terminas amable después de decir que lo piensas.`,
      },
      opener: 'Hola, cuánto cuesta el bótox?',
      maxTurns: 6,
    },
    // ---- The live ad campaigns: these openers are the CTAs the ads send (2026-08-29) ----------
    {
      id: 'cta-laser-co2-valoracion',
      title: 'Anuncio Láser CO₂ — "Sí, quiero una valoración"',
      shows:
        'Llega directo del anuncio del láser con la intención clara. Sofía confirma para qué le sirve, resuelve una duda sobre la recuperación y agenda la consulta.',
      lead: {
        name: 'Claudia',
        phone: '+526141110001',
        channel: 'whatsapp',
        persona: `Tienes 45 años. Tienes manchas por el sol y marcas de acné de la juventud; una amiga te recomendó el láser.
Ya decidiste que quieres la valoración. Solo te preocupa una cosa: cuántos días queda la piel roja o pelándose, porque trabajas atendiendo público.
Puedes ir cualquier día entre semana por la mañana. Cuando te ofrezcan horarios, eliges uno.
Tu objetivo es dejar la consulta agendada. Cuando te la confirmen, agradeces y terminas.`,
      },
      opener: '👌Sí, quiero una valoración para Láser CO2 Fraccionado',
      maxTurns: 7,
      endWhen: { toolCalled: ['bookAppointment'] },
    },
    {
      id: 'cta-laser-co2-dudas',
      title: 'Anuncio Láser CO₂ — "tengo dudas"',
      shows:
        'Viene con dudas, no con decisión. Sofía contesta una a la vez (qué es, si duele, cuántas sesiones) sin abrumar, y solo al final propone la valoración.',
      lead: {
        name: 'Rocío',
        phone: '+526141110002',
        channel: 'whatsapp',
        persona: `Tienes 38 años y poros abiertos y textura irregular en las mejillas. Te llamó la atención el anuncio pero no sabes bien qué es el láser CO2.
Tus dudas, en este orden y de una en una: qué es exactamente y qué hace; si duele; cuántas sesiones se necesitan; y el precio.
Cuando ya tengas esas respuestas, aceptas agendar la valoración. Te acomoda por la tarde.
Cuando te la confirmen, agradeces y terminas.`,
      },
      opener: '🤔Me interesa el Láser CO2 Fraccionado, pero tengo dudas',
      maxTurns: 9,
      endWhen: { toolCalled: ['bookAppointment'] },
    },
    {
      id: 'cta-botox-valoracion',
      title: 'Anuncio Bótox — "Sí, quiero una valoración"',
      shows:
        'Quiere ir en sábado. Sofía no inventa un horario que no existe: le dice cuándo sí hay consulta y encuentra uno que le acomode entre semana.',
      lead: {
        name: 'Ricardo',
        phone: '+526141110003',
        channel: 'whatsapp',
        persona: `Tienes 38 años, hombre, te molestan las patas de gallo y el entrecejo marcado. Es tu primera vez con bótox.
Trabajas de lunes a viernes en horario de oficina, así que primero pides ir el sábado. Si te dicen que no hay sábado, preguntas qué es lo más tarde que hay entre semana y eliges uno de los horarios que te ofrezcan.
Tu objetivo es dejar la consulta agendada. Cuando te la confirmen, agradeces y terminas.`,
      },
      opener: 'Sí, quiero una valoración para Botox',
      maxTurns: 8,
      endWhen: { toolCalled: ['bookAppointment'] },
    },
    {
      id: 'cta-sculptra-dudas',
      title: 'Anuncio Sculptra — "tengo dudas"',
      shows:
        'Pregunta qué es Sculptra y en qué se diferencia del ácido hialurónico. Sofía explica lo que sabe, deja lo médico para el doctor y respeta que quiera pensarlo.',
      lead: {
        name: 'Lorena',
        phone: '+526141110004',
        channel: 'whatsapp',
        persona: `Tienes 52 años y notas flacidez en mejillas y línea de la mandíbula. Viste el anuncio de Sculptra y no sabes si es lo mismo que el ácido hialurónico.
Tus dudas, de una en una: qué es y cómo funciona; en qué se diferencia del ácido hialurónico; cuánto dura el efecto; y el precio.
Al final NO agendas todavía: dices que lo quieres platicar con tu esposo y que tú escribes después. Si te insisten, mantienes que lo vas a pensar.
Terminas amable.`,
      },
      opener: '🤔Me interesa el Sculptra, pero tengo dudas',
      maxTurns: 8,
    },
    // ---- Three more around the same three treatments --------------------------------------------
    {
      id: 'botox-precio-descuento',
      title: 'Bótox — pregunta precio y pide descuento',
      shows:
        'Va directo al precio y pide descuento. Sofía da el precio real, no inventa promociones que no existen y lleva la conversación a la valoración.',
      lead: {
        name: 'Karla',
        phone: '+526141110005',
        channel: 'whatsapp',
        persona: `Tienes 34 años y ya te has puesto bótox en otra clínica, en frente y entrecejo. Lo que te importa es el precio.
Preguntas cuánto cuesta y si el precio es por zona o completo. Luego preguntas si tienen alguna promoción o descuento, o meses sin intereses.
Si no hay descuento, dices que está bien y aceptas agendar la valoración, por la tarde. Eliges un horario de los que te ofrezcan.
Cuando te la confirmen, agradeces y terminas.`,
      },
      opener: 'Hola, cuánto cobran el bótox? es por zona?',
      maxTurns: 8,
      endWhen: { toolCalled: ['bookAppointment'] },
    },
    {
      id: 'laser-co2-mismo-dia',
      title: 'Láser CO₂ — "¿me lo hacen el mismo día?"',
      shows:
        'Pregunta algo que Sofía no tiene en su información (si el láser se aplica el mismo día de la consulta). No inventa: lo confirma con el equipo y aun así deja la cita agendada.',
      lead: {
        name: 'Daniela',
        phone: '+526141110006',
        channel: 'whatsapp',
        persona: `Tienes 29 años y vives en Delicias, a una hora de Chihuahua. Quieres el láser CO2 por cicatrices de acné.
Como vienes de fuera, tu pregunta principal es si te pueden hacer el láser el mismo día de la consulta, para no hacer dos viajes.
Si te dicen que lo confirman con el equipo, lo aceptas y de todos modos agendas la consulta, de preferencia a media mañana. Eliges un horario de los que te ofrezcan.
Cuando te la confirmen, agradeces y terminas.`,
      },
      opener: 'Buenas, me interesa el láser co2 para cicatrices de acné. Vivo en Delicias, me lo pueden hacer el mismo día de la consulta?',
      maxTurns: 7,
      endWhen: { toolCalled: ['bookAppointment'] },
    },
    {
      id: 'sculptra-cambiar-cita',
      title: 'Sculptra — ya tiene cita y quiere moverla',
      shows:
        'Ya tenía su consulta agendada y le surgió un imprevisto. Sofía encuentra la cita, ofrece nuevos horarios y la cambia sin pasar por el equipo.',
      lead: {
        name: 'Patricia',
        phone: '+526141110007',
        channel: 'whatsapp',
        persona: `Tienes 48 años y ya tienes agendada tu consulta de valoración para Sculptra (la agendaste hace unos días por este mismo chat).
Te salió un compromiso de trabajo y no vas a poder ir. Quieres moverla a la semana siguiente, por la tarde.
Cuando te ofrezcan horarios nuevos, eliges uno. Cuando te confirmen el cambio, agradeces y terminas.`,
      },
      opener: 'Hola, tengo cita de valoración esta semana pero me salió un imprevisto, la puedo cambiar?',
      maxTurns: 7,
      endWhen: { toolCalled: ['rescheduleAppointment'] },
      preset: { appointment: { serviceName: 'Consulta', daysAhead: 2, time: '11:00' } },
    },
  ],
};
