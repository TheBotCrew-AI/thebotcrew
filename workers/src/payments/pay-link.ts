/**
 * pay-link — the short payment link the lead actually receives (0063).
 *
 * Stripe's Checkout URL is ~300 characters with a `#fragment` the model has to copy by
 * hand into its reply, and on 2026-09-22 it copied the fragment twice (a dead link) and
 * dragged the tool's instructions along with it. So the model never sees Stripe's URL:
 * a hold gets a 10-character code, the lead gets `<WORKER_URL>/p/<code>`, and the Worker
 * redirects to Stripe (`worker/pay-link-handler.ts`) — or, once the hold is paid or
 * released, tells the lead so instead of handing them Stripe's generic error.
 *
 * The alphabet is lowercase and drops the look-alikes (0/o, 1/l/i): a lead reading the
 * code off a screen, a keyboard autocapitalizing it, or the model re-typing it, can't
 * turn one character into another. 31^10 ≈ 2^49 — unguessable, and the code is the only
 * key to the link (it opens someone's checkout), so it is random, never sequential.
 */

export const SHORT_CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
export const SHORT_CODE_LENGTH = 10;
const SHORT_CODE_RE = new RegExp(`^[${SHORT_CODE_ALPHABET}]{${SHORT_CODE_LENGTH}}$`);

/** Where the Worker answers — Checkout's return pages and the short links hang off it. */
const DEFAULT_WORKER_URL = 'https://thebotcrew-agents.floral-credit-be7e.workers.dev';

export function workerBaseUrl(): string {
  return (process.env.WORKER_URL?.trim() || DEFAULT_WORKER_URL).replace(/\/+$/, '');
}

/** Uniform over the alphabet: bytes ≥ 248 (= 8 × 31) are rejected instead of taken mod 31. */
export function newShortCode(random: (buf: Uint8Array) => Uint8Array = (b) => crypto.getRandomValues(b)): string {
  const limit = Math.floor(256 / SHORT_CODE_ALPHABET.length) * SHORT_CODE_ALPHABET.length;
  let out = '';
  while (out.length < SHORT_CODE_LENGTH) {
    const bytes = random(new Uint8Array(SHORT_CODE_LENGTH * 2));
    for (const b of bytes) {
      if (b >= limit) continue;
      out += SHORT_CODE_ALPHABET[b % SHORT_CODE_ALPHABET.length];
      if (out.length === SHORT_CODE_LENGTH) break;
    }
  }
  return out;
}

/** The code as stored: lowercase, exact length, alphabet only — or null for anything else. */
export function normalizeShortCode(raw: string | null | undefined): string | null {
  const code = (raw ?? '').trim().toLowerCase();
  return SHORT_CODE_RE.test(code) ? code : null;
}

export function payLinkUrl(base: string, code: string): string {
  return `${base.replace(/\/+$/, '')}/p/${code}`;
}

/** The link the lead gets: the short one when the hold has a code, Stripe's for a hold born before 0063. */
export function paymentLinkFor(hold: { shortCode?: string | null; checkoutUrl: string }, base = workerBaseUrl()): string {
  return hold.shortCode ? payLinkUrl(base, hold.shortCode) : hold.checkoutUrl;
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/**
 * Deterministic repair of every short link in a reply: whatever the model glued onto a
 * well-formed code (a second copy of the code, a trailing instruction, punctuation) is cut
 * so the link ends exactly where the code ends. A code the model mangled itself can't be
 * repaired here — the short length is what makes that rare.
 */
export function fixPayLinks(text: string, base = workerBaseUrl()): string {
  const re = new RegExp(`${escapeRe(base)}/p/([${SHORT_CODE_ALPHABET}]{${SHORT_CODE_LENGTH}})\\S*`, 'gi');
  return text.replace(re, (_m, code: string) => payLinkUrl(base, code.toLowerCase()));
}
