/**
 * HappyNatyNat — the showcase battery for the Full Color ads.
 *
 * One lead per ad (each opens with that ad's preset phrase, so it lands on its variant the way
 * prod pins it) plus the two objections the ad brief expects most. The goal is always the same:
 * the free 30-minute Meet call with Nat, on a Tuesday.
 */

import { happyNatyTenant } from '../../roles/front-desk/evals/fixtures.js';
import type { TenantScenarios } from '../scenario.js';

const GOAL = `Tu objetivo es terminar con tu llamada con Nat agendada. Cuando te ofrezcan horarios, eliges uno.
Si te piden tu nombre, lo das. Cuando te la confirmen, agradeces y terminas.`;

export const happyNaty: TenantScenarios = {
  slug: 'happynaty',
  ghlLocationId: 'X8zdJcQaVckHuF3W4grr',
  fixture: happyNatyTenant,
  assistantName: 'HappyNatyNat',
  scenarios: [
    {
      id: 'p2b-misma-blusa',
      title: 'Presentación — la misma blusa en dos colores',
      shows: 'No conocía a Nat. Primero le explica por qué pasa y le pregunta por su experiencia; la llamada llega cuando ya le interesó.',
      lead: {
        name: 'Daniela',
        channel: 'instagram',
        persona: `Tienes 29 años, vives en Tijuana. Te salió un anuncio de una blusa en dos colores y te dio curiosidad.
Tienes una blusa verde que te encantó en la tienda y nunca te pones porque "no sabes qué tiene".
No sabías que existía el análisis de color. Contestas corto, como en Instagram. Si te explican algo interesante, te emocionas.
${GOAL}`,
      },
      opener: '¿Por qué la misma blusa se ve distinta según el color?',
      promptVariant: 'p2b',
      maxTurns: 9,
      endWhen: { toolCalled: ['bookAppointment'] },
    },
    {
      id: 'p4-tinte',
      title: 'Presentación — el tinte que la apagó',
      shows: 'Ya tuvo un tinte que no le quedó. Al llegar a la oferta, la guía 3 en 1 se conecta con su colorista.',
      lead: {
        name: 'Karla',
        phone: '+526642223344',
        channel: 'whatsapp',
        persona: `Tienes 41 años, vives en Tijuana. Hace un año te pusiste un rubio cenizo y todos te preguntaban si estabas enferma.
Quieres volver a cambiar de color pero te da miedo equivocarte otra vez. Vas con la misma colorista de siempre.
En algún momento preguntas cuánto cuesta.
${GOAL}`,
      },
      opener: '¿Qué color de tinte me favorece?',
      promptVariant: 'p4',
      maxTurns: 9,
      endWhen: { toolCalled: ['bookAppointment'] },
    },
    {
      id: 'p8-labiales',
      title: 'Presentación — el cajón de labiales',
      shows: 'Ya sabe que compra a prueba y error. Un mensaje de valor y va directo a la llamada.',
      lead: {
        name: 'Fernanda',
        channel: 'facebook',
        persona: `Tienes 35 años, vives en Tijuana. Tienes un cajón lleno de labiales que no usas.
Lo que más quieres resolver es el maquillaje. Eres práctica: si te convence, agendas rápido.
${GOAL}`,
      },
      opener: '¿Cómo puedo conocer mis colores?',
      promptVariant: 'p8',
      maxTurns: 8,
      endWhen: { toolCalled: ['bookAppointment'] },
    },
    {
      id: 'c1-filtros',
      title: 'Cierre — ya probó filtros y apps',
      shows: 'Llega con más intención: la oferta va en el primer mensaje y la llamada en el segundo.',
      lead: {
        name: 'Alejandra',
        channel: 'instagram',
        persona: `Tienes 33 años, vives en Tijuana. Probaste dos apps de colorimetría: una te dijo otoño y otra invierno.
Desconfías de las opciones baratas y quieres algo hecho en persona. Preguntas si es presencial.
${GOAL}`,
      },
      opener: 'Quiero saber mis colores reales, sin filtro',
      promptVariant: 'c1',
      maxTurns: 8,
      endWhen: { toolCalled: ['bookAppointment'] },
    },
    {
      id: 'c2-estacion',
      title: 'Cierre — "ya sé que soy primavera"',
      shows: 'Ya le dijeron su estación. Se valida lo que sabe, sin corregirla, y se explica la combinación de 3.',
      lead: {
        name: 'Paola',
        phone: '+526645556677',
        channel: 'whatsapp',
        persona: `Tienes 38 años, vives en Tijuana. Hace años una amiga te dijo que eres primavera, pero sigues sin atinarle a lo que compras.
Mandas una selfie y preguntas qué colores te quedan (escribe la foto como: "[Foto que mandó: selfie de una mujer de piel clara con pecas y cabello cobrizo, luz de ventana]").
${GOAL}`,
      },
      opener: '¿Cuál es mi combinación de colores?',
      promptVariant: 'c2',
      maxTurns: 9,
      endWhen: { toolCalled: ['bookAppointment'] },
    },
    {
      id: 'c3-comparando-caro',
      title: 'Cierre — comparando opciones, "está caro"',
      shows: 'Pidió ver todo lo que incluye. Recibe la lista completa, el precio cuando lo pide, y la objeción de precio se resuelve sin descuentos.',
      lead: {
        name: 'Mónica',
        phone: '+526646667788',
        channel: 'whatsapp',
        persona: `Tienes 45 años, vives en Tijuana. Estás comparando con otra asesora que cobra $2,500 por una sesión con foto.
Preguntas el precio y dices que está caro. Si te explican bien la diferencia, aceptas la llamada.
${GOAL}`,
      },
      opener: 'Quiero ver todo lo que incluye la sesión',
      promptVariant: 'c3',
      maxTurns: 10,
      endWhen: { toolCalled: ['bookAppointment'] },
    },
    {
      id: 'c3-san-diego-ingles',
      title: 'Cierre — de San Diego, en inglés',
      shows: 'Escribe en inglés desde San Diego: le contesta en inglés y la agenda igual (misma región).',
      lead: {
        name: 'Jessica',
        channel: 'instagram',
        persona: `You are 31, you live in San Diego and cross to Tijuana often. You only write in English.
You want to know what's included and whether it's in person.
Your goal is to book the call with Nat. When offered times, pick one. Give your name if asked. Say thanks when confirmed.`,
      },
      opener: 'Hi! I want to see everything the session includes',
      promptVariant: 'c3',
      maxTurns: 8,
      endWhen: { toolCalled: ['bookAppointment'] },
    },
  ],
};
