/**
 * GHL App Marketplace OAuth2 flow.
 *
 * Covers install (auth URL generation), code exchange, and token refresh.
 * The Worker exposes /oauth/ghl/install and /oauth/callback routes that call
 * into this module (see `mastra/index.ts`). GHL_OAUTH_REDIRECT_URI must point at
 * /oauth/callback — NOT /oauth/ghl/callback, which does not exist. Tokens are
 * persisted to `ghl_oauth_tokens` via the DB layer so GhlClient can fetch them
 * per-tenant at request time.
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
  // Required to READ the conversation object (GET /conversations/{id}) — distinct from
  // the message scopes above. Contact-merge recovery on send re-resolves the live
  // contactId from the conversation (GhlClient.getConversationContactId); without this
  // scope that call 401s and recovery silently fails, so a Facebook Instant-Form lead
  // whose contact GHL merged away is never replied to (CONVERSATIONS_CONTACT_NOT_FOUND).
  'conversations.readonly',
  'calendars/events.write',
  // GHL splits calendar reads from writes, and events.write grants NEITHER read below:
  //  • calendars.readonly       — LIST a location's calendars (GET /calendars?locationId=).
  //    Onboarding needs it to fill tenant_config.calendars (service -> calendar id) without
  //    digging the id out of the GHL UI by hand.
  //  • calendars/events.readonly — READ one appointment (GET /calendars/events/appointments/{id}),
  //    i.e. GhlClient.getAppointment. Without it that call 401s on every tenant, and because
  //    lookupAppointment swallows the error and falls back to our stored datetime, the bot
  //    silently reports a stale time for any appointment moved or cancelled directly in GHL.
  // Both are read-only. Verified live 2026-07-22: without them GHL answers
  // {"statusCode":401,"message":"The token is not authorized for this scope."}
  'calendars.readonly',
  'calendars/events.readonly',
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
