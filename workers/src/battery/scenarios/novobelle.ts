/**
 * Novobelle — the live-demo tenant (Leo's spare GHL subaccount, IG only). Runs on the LIVE
 * config from Supabase (falls back to the synthetic prime-time fixture without env), so a
 * run here is what a prospect gets when they DM the page.
 *
 *   pnpm battery novobelle
 */

import { primeTimeDemoTenant } from './prime-time-demo.js';
import type { TenantScenarios } from '../scenario.js';

export const novobelle: TenantScenarios = {
  slug: 'novobelle',
  ghlLocationId: 'Q9fKyV7kQGA4brb6wbH5',
  fixture: primeTimeDemoTenant,
  assistantName: 'Mariana',
  scenarios: [
    {
      id: 'happy-path-valoracion-prime',
      title: 'No sabe qué le conviene → valoración gratuita → solo puede en la tarde',
      shows: 'Entra con dudas y precios, Mariana la lleva a la valoración gratuita; pide las 6 p.m., primero recibe horarios de antes de las 5 y solo cuando dice que no puede en ninguno se le abre la tarde.',
      lead: {
        name: 'Ana Torres',
        channel: 'instagram',
        persona: 'Sigues el guion al pie de la letra; no improvisas.',
      },
      opener: 'Hola, ¿qué tratamientos manejan? Tengo manchas y unas líneas en la frente',
      script: [
        '¿Y cuánto cuesta cada uno?',
        'Es que no sé cuál me conviene a mí',
        'Sí, ¿tienen mañana a las 6 de la tarde?',
        'No puedo en esos, trabajo. De plano solo puedo de 6 en adelante',
        'El de las 7 está bien',
        'Ana Torres, +52 229 123 4567',
        'Gracias',
      ],
      maxTurns: 8,
      endWhen: { toolCalled: ['bookAppointment'] },
      closingTurns: 1,
    },
  ],
};
