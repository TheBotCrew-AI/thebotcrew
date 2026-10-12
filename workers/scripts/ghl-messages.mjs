/**
 * Lista los últimos mensajes de una conversación de GHL con su status, tipo y adjuntos,
 * tal como los ve GHL (no nuestra DB). Para diagnosticar entregas: un envío que la API
 * aceptó con 201 puede quedar `failed` o perder el adjunto por el camino.
 *
 * Uso: node scripts/ghl-messages.mjs <tenantId> <ghlConversationId> [limit]
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GHL_CLIENT_ID, GHL_CLIENT_SECRET
 */
import { createClient } from '@supabase/supabase-js';

const [tenantId, conversationId, limitArg] = process.argv.slice(2);
if (!tenantId || !conversationId) {
  console.error('uso: node scripts/ghl-messages.mjs <tenantId> <ghlConversationId> [limit]');
  process.exit(1);
}
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const { data } = await supabase.from('ghl_oauth_tokens').select('access_token, refresh_token, expires_at').eq('tenant_id', tenantId).maybeSingle();
if (!data) { console.error('sin token'); process.exit(1); }
let token = data.access_token;
if (data.expires_at && Date.parse(data.expires_at) <= Date.now() + 60_000) {
  const res = await fetch('https://services.leadconnectorhq.com/oauth/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: process.env.GHL_CLIENT_ID, client_secret: process.env.GHL_CLIENT_SECRET, grant_type: 'refresh_token', refresh_token: data.refresh_token, user_type: 'Location' }),
  });
  const fresh = await res.json(); token = fresh.access_token;
  await supabase.from('ghl_oauth_tokens').upsert({ tenant_id: tenantId, access_token: fresh.access_token, refresh_token: fresh.refresh_token, expires_at: new Date(Date.now() + fresh.expires_in * 1000).toISOString(), token_type: fresh.token_type ?? 'Bearer' }, { onConflict: 'tenant_id' });
}
const res = await fetch(`https://services.leadconnectorhq.com/conversations/${conversationId}/messages?limit=${limitArg ?? 5}`, {
  headers: { Authorization: `Bearer ${token}`, Version: '2021-04-15' },
});
console.log('HTTP', res.status);
const body = await res.json();
const msgs = body.messages?.messages ?? body.messages ?? body;
for (const m of Array.isArray(msgs) ? msgs : []) {
  console.log(JSON.stringify({ id: m.id, dir: m.direction, type: m.messageType ?? m.type, status: m.status, body: (m.body ?? '').slice(0, 60), attachments: m.attachments, meta: m.meta, error: m.error ?? m.failureReason }, null, 0));
}
