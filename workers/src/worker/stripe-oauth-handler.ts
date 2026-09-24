/**
 * GET /stripe/oauth/callback — where Stripe sends a client after they authorize the
 * platform to connect their EXISTING Stripe account (Connect OAuth, Standard).
 *
 * The connection only exists once the `ac_…` code is exchanged; this route does that
 * exchange and shows the client a "listo" page. The resulting `acct_…` is logged
 * (`[stripe-oauth] connected`) and shown on the page, and the account appears in the
 * platform's Connected accounts. Nothing is written to the tenant: an operator sets
 * `booking_payment.stripe_account` by hand after checking the account is complete.
 *
 * The code does not say which mode the authorization ran in, so each configured key
 * is tried, the current mode's first; a 4xx moves on to the next key, anything else
 * stops. A connection nobody asked for is harmless — it moves no money until an
 * operator puts its id in a tenant row — so there is no `state` check.
 *
 * Kept pure (no Hono) so the outcomes are unit-testable against a mocked fetch.
 */

import { exchangeOAuthCode, stripeSecretKeys } from '../payments/stripe.js';

export interface StripeOAuthQuery {
  code?: string;
  error?: string;
  error_description?: string;
}

export interface StripeOAuthOutcome {
  status: 200 | 400 | 502 | 503;
  html: string;
  /** The connected account, on success. */
  account?: string;
}

const CODE_RE = /^ac_[A-Za-z0-9]{8,}$/;

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] ?? ch);
}

function page(title: string, heading: string, body: string): string {
  return (
    `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title></head>` +
    '<body style="font-family:sans-serif;padding:2rem;max-width:32rem;margin:auto;text-align:center">' +
    `<h2>${heading}</h2>${body}</body></html>`
  );
}

const TRY_AGAIN = '<p>No se conectó nada. Avísale a quien te mandó la liga para que te envíe una nueva.</p>';

export async function handleStripeOAuthCallback(query: StripeOAuthQuery): Promise<StripeOAuthOutcome> {
  if (query.error) {
    // access_denied = the client clicked "cancel" on Stripe's page.
    console.warn(`[stripe-oauth] authorization not granted: ${query.error} ${query.error_description ?? ''}`.trim());
    return { status: 400, html: page('Conexión cancelada', 'No se conectó tu cuenta', TRY_AGAIN) };
  }
  const code = query.code?.trim() ?? '';
  if (!CODE_RE.test(code)) {
    return { status: 400, html: page('Liga incompleta', 'Esta liga no está completa', TRY_AGAIN) };
  }

  const keys = stripeSecretKeys();
  if (keys.length === 0) {
    console.error('[stripe-oauth] no STRIPE_SECRET_KEY(_TEST_MODE) set — cannot exchange the code');
    return { status: 503, html: page('No disponible', 'No pudimos terminar la conexión', TRY_AGAIN) };
  }

  for (const { mode, secretKey } of keys) {
    let result;
    try {
      result = await exchangeOAuthCode(secretKey, code);
    } catch (e) {
      console.error(`[stripe-oauth] exchange with the ${mode} key failed:`, e instanceof Error ? e.message : String(e));
      break;
    }
    if (result.ok) {
      console.log(
        `[stripe-oauth] connected account=${result.stripeUserId} livemode=${result.livemode} scope=${result.scope ?? ''} key=${mode}`,
      );
      const account = escapeHtml(result.stripeUserId);
      return {
        status: 200,
        account: result.stripeUserId,
        html: page(
          'Cuenta conectada',
          '¡Listo! Tu cuenta de Stripe quedó conectada ✅',
          '<p>Ya puedes cerrar esta ventana. Los pagos de tus citas van a llegar directo a tu cuenta.</p>' +
            `<p style="color:#666;font-size:.85rem">Cuenta: <code>${account}</code>${result.livemode ? '' : ' · modo de prueba'}</p>`,
        ),
      };
    }
    console.error(
      `[stripe-oauth] exchange with the ${mode} key refused: ${result.status} ${result.error} ${result.description}`.trim(),
    );
    if (result.status < 400 || result.status >= 500) break;
  }
  return { status: 502, html: page('Error', 'No pudimos terminar la conexión', TRY_AGAIN) };
}
