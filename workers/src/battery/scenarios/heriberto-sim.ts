/**
 * Dr. Heriberto Valdivia — one-off simulations, NOT the client showcase.
 *
 * Cases to look at before a config decision ("what would the bot say if…"). Kept out of the
 * `heriberto` bundle so they never land in the client's `reporte.html`.
 *
 *   pnpm battery heriberto-sim --only <id>
 */

import { heribertoTenant } from '../../roles/front-desk/evals/fixtures.js';
import type { TenantScenarios } from '../scenario.js';

const COTIZACION_OPENER =
  'Buen día, tengo una cotización de 4000, pesos que me hizo para láser co2 más  subsicion,  me podría indicar que días tiene disponobles y donde se ubica, quedo atenta.';

const COTIZACION_PERSONA = `Tienes 38 años, vives en Chihuahua. Ya fuiste con el Dr. Valdivia: te revisó y te cotizó $4,000 por láser CO2 más subcisión para unas cicatrices de acné. Ya decidiste hacértelo; ahora solo quieres la fecha.
No sabes nada de promociones ni de "primera visita": para ti ya es el tratamiento, no una consulta.
Si te ofrecen horarios, eliges el más tarde que te den.
Si te hablan de un depósito o de pagar algo por adelantado, preguntas si eso se descuenta de los $4,000 y si ese día ya te hacen el tratamiento.
Si te mandan una liga de pago, dices que ahorita la pagas, agradeces y terminas.
Escribes corto, como en Messenger.`;

export const heribertoSim: TenantScenarios = {
  slug: 'heriberto-sim',
  ghlLocationId: 'rfL7uM3c5mpfIUGxCR3C',
  fixture: heribertoTenant,
  assistantName: 'Sofía',
  scenarios: [
    {
      id: 'cotizacion-laser-plan',
      title: 'Ya trae cotización de láser — conversación en PLAN desde el inicio',
      shows: 'La paciente ya tiene su cotización del doctor y solo quiere fecha. La conversación está en la campaña PLAN (cobra depósito).',
      lead: { name: 'Karla', channel: 'facebook', persona: COTIZACION_PERSONA },
      promptVariant: 'i01',
      opener: COTIZACION_OPENER,
      maxTurns: 6,
      endWhen: { toolCalled: ['bookAppointment'] },
    },
    {
      id: 'cotizacion-laser-plan-continua',
      title: 'Ya trae cotización de láser — se pasa a PLAN a media conversación',
      shows: 'El hilo real (contestado sin campaña) y, a partir de su respuesta, la conversación ya en PLAN.',
      lead: { name: 'Karla', channel: 'facebook', persona: COTIZACION_PERSONA },
      promptVariant: 'i01',
      history: [
        { from: 'lead', text: COTIZACION_OPENER },
        {
          from: 'bot',
          text: '¡Buen día! Soy Sofía, del consultorio del Dr. Heriberto Valdivia. Claro, con gusto revisamos tu cita para láser CO₂ y subcisión; en consulta el Dr. confirma el plan antes de aplicar cualquier tratamiento.',
        },
        { from: 'bot', text: 'Tengo martes, 29 de septiembre, 3:45 p.m. o martes, 29 de septiembre, 5:45 p.m. ¿Cuál de los dos te acomoda?' },
        {
          from: 'bot',
          text: 'Estamos en Periférico de la Juventud 6902, Plaza Cumbres, Local 34, Chihuahua, Chih., justo enfrente de la tienda de AT&T.',
        },
        { from: 'bot', text: '¡Qué gusto saludarte nuevamente! De los horarios que te compartí, ¿alguno te acomoda o te busco otra opción?' },
      ],
      opener: 'Si, el martes a las 5:45 está bien',
      maxTurns: 5,
      endWhen: { toolCalled: ['bookAppointment'] },
    },
  ],
};
