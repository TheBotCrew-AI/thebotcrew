/**
 * GET /p/:code — the short payment link the lead taps (0063).
 *
 * While the hold is pending the route is a plain 302 to the Stripe Checkout URL stored
 * on the row (the `#fragment` rides along in Location). Once the hold has moved on, the
 * lead gets a sentence instead of Stripe's generic "expired" page: paid → "ya está
 * pagado", released → "venció, escríbenos". An unknown or malformed code is a 404 that
 * reveals nothing — the code is the only key to someone's checkout.
 *
 * Kept pure (no Hono) so the four outcomes are unit-testable against a mocked query.
 */

import { getBookingHoldByShortCode } from '../db/queries.js';
import { normalizeShortCode } from '../payments/pay-link.js';

export type PayLinkOutcome =
  | { kind: 'redirect'; status: 302; location: string }
  | { kind: 'page'; status: 200 | 404 | 410; html: string };

function page(title: string, heading: string, body: string): string {
  return (
    `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title></head>` +
    '<body style="font-family:sans-serif;padding:2rem;max-width:32rem;margin:auto;text-align:center">' +
    `<h2>${heading}</h2><p>${body}</p></body></html>`
  );
}

export async function resolvePayLink(rawCode: string): Promise<PayLinkOutcome> {
  const notFound: PayLinkOutcome = {
    kind: 'page',
    status: 404,
    html: page('Liga no encontrada', 'Esta liga no existe', 'Revisa que la hayas copiado completa desde el chat, o pídenos una nueva por ahí mismo.'),
  };
  const code = normalizeShortCode(rawCode);
  if (!code) return notFound;

  const hold = await getBookingHoldByShortCode(code);
  if (!hold) return notFound;

  switch (hold.status) {
    case 'pending':
      return { kind: 'redirect', status: 302, location: hold.checkoutUrl };
    case 'paid':
    case 'paid_late':
      return {
        kind: 'page',
        status: 200,
        html: page('Apartado pagado', 'Este apartado ya está pagado', 'No hay nada más que hacer aquí. Si necesitas mover tu cita, escríbenos por el mismo chat donde agendaste.'),
      };
    default:
      // expiring (the cron is releasing it right now), expired, cancelled
      return {
        kind: 'page',
        status: 410,
        html: page('Apartado vencido', 'Este apartado ya venció', 'El lugar se liberó y esta liga ya no sirve. Escríbenos por el mismo chat donde agendaste y con gusto te apartamos otro horario.'),
      };
  }
}
