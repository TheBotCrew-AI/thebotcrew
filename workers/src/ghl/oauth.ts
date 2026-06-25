/**
 * GHL App Marketplace OAuth2 flow.
 *
 * Covers install (auth URL generation), code exchange, and token refresh.
 * The Worker exposes /oauth/ghl/install and /oauth/ghl/callback routes that
 * call into this module. Tokens are persisted to `ghl_oauth_tokens` via the
 * DB layer so GhlClient can fetch them per-tenant at request time.
 *
 * TODO(GHL): confirm exact scope strings and whether GHL returns `locationId`
 * directly in the token response or only in the callback query params.
 */

import { getGhlOAuthEnv } from '../core/env.js';

const GHL_AUTH_URL = 'https://marketplace.gohighlevel.com/oauth/chooselocation';
const GHL_TOKEN_URL = 'https://services.leadconnectorhq.com/oauth/token';

const SCOPES = [
  'conversations/message.readonly',
  'conversations/message.write',
  'calendars/events.write',
  'contacts.readonly',
  // Required to write the `bot-off` / status tags back onto the GHL contact.
  'contacts.write',
].join(' ');

export interface GhlTokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
  locationId: string;
}

/** Build the GHL authorization URL to redirect a user to during app install. */
export function getInstallUrl(state: string): string {
  const env = getGhlOAuthEnv();
  const params = new URLSearchParams({
    response_type: 'code',
    redirect_uri: env.redirectUri,
    client_id: env.clientId,
    scope: SCOPES,
    state,
  });
  return `${GHL_AUTH_URL}?${params}`;
}

/** Exchange an authorization code for access + refresh tokens. */
export async function exchangeCode(code: string): Promise<GhlTokenResponse> {
  const env = getGhlOAuthEnv();
  const res = await fetch(GHL_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: env.redirectUri,
      client_id: env.clientId,
      client_secret: env.clientSecret,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GHL token exchange failed (${res.status}): ${text}`);
  }
  return res.json() as Promise<GhlTokenResponse>;
}

/** Refresh an expired access token using the stored refresh token. */
export async function refreshAccessToken(refreshToken: string): Promise<GhlTokenResponse> {
  const env = getGhlOAuthEnv();
  const res = await fetch(GHL_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: env.clientId,
      client_secret: env.clientSecret,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GHL token refresh failed (${res.status}): ${text}`);
  }
  return res.json() as Promise<GhlTokenResponse>;
}
