/**
 * Limpia el contacto de GHL de una conversación de prueba: verifica que siga vivo
 * y le quita las etiquetas que el bot escribe (estado + embudo de demo + colas).
 *
 * La parte de la DB se hace aparte; esto es solo el lado de GHL, que es el que
 * no se ve en Supabase y deja el siguiente test contaminado.
 *
 * Uso: node scripts/reset-test-contact.mjs <tenantId> <contactId>
 */
import { createClient } from '@supabase/supabase-js';

const [tenantId, contactId] = process.argv.slice(2);
if (!tenantId || !contactId) {
  console.error('uso: node scripts/reset-test-contact.mjs <tenantId> <contactId>');
  process.exit(1);
}

const TAGS = [
  'bot-off',
  'bot-completed',
  'bot-opted-out',
  'bot-standby',
  'esperando-agenda',
  'dato-pendiente',
  'reactivacion-agotada',
  'demo-iniciada',
  'demo-completada',
  'demo-incompleta',
  'marketing-opt-out',
];

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
  await supabase
    .from('ghl_oauth_tokens')
    .update({
      access_token: fresh.access_token,
      refresh_token: fresh.refresh_token,
      expires_at: new Date(Date.now() + fresh.expires_in * 1000).toISOString(),
    })
    .eq('tenant_id', tenantId);
  console.log('token refrescado');
}

const headers = { Authorization: `Bearer ${token}`, Version: '2021-07-28' };

const got = await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}`, { headers });
if (!got.ok) {
  console.log(`contacto ${contactId}: NO existe (HTTP ${got.status}) → la fila está huérfana`);
  process.exit(2);
}
const body = await got.json();
const tagsNow = body?.contact?.tags ?? [];
console.log(`contacto ${contactId}: vivo. etiquetas actuales: ${JSON.stringify(tagsNow)}`);

const toRemove = TAGS.filter((t) => tagsNow.includes(t));
if (toRemove.length === 0) {
  console.log('no hay etiquetas del bot que quitar');
  process.exit(0);
}

const del = await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}/tags`, {
  method: 'DELETE',
  headers: { ...headers, 'Content-Type': 'application/json' },
  body: JSON.stringify({ tags: toRemove }),
});
console.log(del.ok ? `etiquetas quitadas: ${toRemove.join(', ')}` : `falló quitar etiquetas: ${del.status} ${(await del.text()).slice(0, 200)}`);
