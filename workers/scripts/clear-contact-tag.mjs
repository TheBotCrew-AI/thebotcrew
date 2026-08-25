/**
 * Quita UNA etiqueta de varios contactos de GHL de un tenant.
 *
 * Para limpiar una cola entera (p. ej. `dato-pendiente` después de cargar a la config
 * los datos que faltaban): la lista de contactos sale de Supabase, el token OAuth del
 * tenant también, y aquí solo se imprime el id y el resultado — nunca el token.
 *
 * Uso: node scripts/clear-contact-tag.mjs <tenantId> <tag> <contactId> [<contactId> ...]
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GHL_CLIENT_ID, GHL_CLIENT_SECRET
 */
import { createClient } from '@supabase/supabase-js';

const [tenantId, tag, ...contactIds] = process.argv.slice(2);
if (!tenantId || !tag || contactIds.length === 0) {
  console.error('uso: node scripts/clear-contact-tag.mjs <tenantId> <tag> <contactId> [...]');
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

let ok = 0;
for (const contactId of contactIds) {
  const res = await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}/tags`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}`, Version: '2021-07-28', 'Content-Type': 'application/json' },
    body: JSON.stringify({ tags: [tag] }),
  });
  if (res.ok) {
    ok++;
    console.log(`ok   ${contactId}`);
  } else {
    console.log(`FAIL ${contactId} ${res.status} ${(await res.text()).slice(0, 120)}`);
  }
}
console.log(`${ok}/${contactIds.length} contactos sin "${tag}"`);
