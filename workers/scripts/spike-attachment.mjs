/**
 * Spike (fase 3 del playbook): ¿GHL entrega un adjunto por URL en cada canal?
 *
 * Manda UN mensaje con `attachments: [url]` (+ texto opcional) a un contacto de prueba
 * por el canal indicado, con el token OAuth del tenant, e imprime status + respuesta
 * cruda de la API. No toca nuestra DB ni el runner: es sólo para saber qué acepta
 * WhatsApp, Facebook e Instagram antes de diseñar la biblioteca de activos.
 *
 * Uso: node scripts/spike-attachment.mjs <tenantId> <contactId> <whatsapp|facebook|instagram> <url> [texto]
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GHL_CLIENT_ID, GHL_CLIENT_SECRET
 */
import { createClient } from '@supabase/supabase-js';

const [tenantId, contactId, channel, url, ...rest] = process.argv.slice(2);
const text = rest.join(' ');
if (!tenantId || !contactId || !channel || !url) {
  console.error('uso: node scripts/spike-attachment.mjs <tenantId> <contactId> <canal> <url> [texto]');
  process.exit(1);
}
const type = { whatsapp: 'WhatsApp', facebook: 'FB', instagram: 'IG' }[channel];
if (!type) {
  console.error('canal inválido:', channel);
  process.exit(1);
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const { data, error } = await supabase
  .from('ghl_oauth_tokens')
  .select('access_token, refresh_token, expires_at')
  .eq('tenant_id', tenantId)
  .maybeSingle();
if (error || !data) {
  console.error('no hay token OAuth para ese tenant:', error?.message ?? 'sin fila');
  process.exit(1);
}

let token = data.access_token;
if (data.expires_at && Date.parse(data.expires_at) <= Date.now() + 60_000) {
  const res = await fetch('https://services.leadconnectorhq.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GHL_CLIENT_ID,
      client_secret: process.env.GHL_CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: data.refresh_token,
      user_type: 'Location',
    }),
  });
  if (!res.ok) {
    console.error('refresh falló:', res.status, (await res.text()).slice(0, 200));
    process.exit(1);
  }
  const fresh = await res.json();
  token = fresh.access_token;
  await supabase.from('ghl_oauth_tokens').upsert(
    {
      tenant_id: tenantId,
      access_token: fresh.access_token,
      refresh_token: fresh.refresh_token,
      expires_at: new Date(Date.now() + fresh.expires_in * 1000).toISOString(),
      token_type: fresh.token_type ?? 'Bearer',
    },
    { onConflict: 'tenant_id' },
  );
}

const body = { type, contactId, attachments: [url] };
if (text) body.message = text;
const res = await fetch('https://services.leadconnectorhq.com/conversations/messages', {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, Version: '2023-02-21', 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
console.log(`${channel} ${type} → HTTP ${res.status}`);
console.log((await res.text()).slice(0, 600));
