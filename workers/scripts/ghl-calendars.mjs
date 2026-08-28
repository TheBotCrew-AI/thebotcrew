/**
 * Lista los calendarios de un tenant en GHL y, para cada uno, la disponibilidad real de
 * los próximos N días agrupada por día — el paso 3 del onboarding (docs/onboarding.md):
 * de aquí salen los ids para `tenant_config.calendars` y la comparación contra `hours`.
 *
 * El token OAuth sale de Supabase y se refresca si venció; aquí solo se imprimen ids,
 * nombres y horarios — nunca el token.
 *
 * Uso: node scripts/ghl-calendars.mjs <tenantId> [dias=7]
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GHL_CLIENT_ID, GHL_CLIENT_SECRET
 */
import { createClient } from '@supabase/supabase-js';

const [tenantId, daysArg] = process.argv.slice(2);
const days = Number(daysArg ?? 7);
if (!tenantId) {
  console.error('uso: node scripts/ghl-calendars.mjs <tenantId> [dias=7]');
  process.exit(1);
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const { data: tenant, error: tErr } = await supabase
  .from('tenants')
  .select('ghl_location_id, tenant_config(timezone, calendars, hours)')
  .eq('id', tenantId)
  .maybeSingle();
if (tErr || !tenant) {
  console.error('tenant no encontrado:', tErr?.message ?? 'sin fila');
  process.exit(1);
}
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
      refresh_token: fresh.refresh_token ?? data.refresh_token,
      expires_at: new Date(Date.now() + fresh.expires_in * 1000).toISOString(),
    })
    .eq('tenant_id', tenantId);
}

const headers = { Authorization: `Bearer ${token}`, Version: '2021-04-15', Accept: 'application/json' };
const base = 'https://services.leadconnectorhq.com';

const calRes = await fetch(`${base}/calendars/?locationId=${tenant.ghl_location_id}`, { headers });
if (!calRes.ok) {
  console.error('GET /calendars falló:', calRes.status, (await calRes.text()).slice(0, 300));
  process.exit(1);
}
const { calendars = [] } = await calRes.json();
const cfg = Array.isArray(tenant.tenant_config) ? tenant.tenant_config[0] : tenant.tenant_config;
console.log(`location ${tenant.ghl_location_id} · timezone config: ${cfg?.timezone}`);
console.log(`hours config: ${JSON.stringify(cfg?.hours)}`);
console.log(`calendars config: ${JSON.stringify(cfg?.calendars)}\n`);

const start = Date.now();
const end = start + days * 24 * 60 * 60 * 1000;
for (const c of calendars) {
  console.log(`— ${c.name}  id=${c.id}  active=${c.isActive}  slotDuration=${c.slotDuration ?? '?'}${c.slotDurationUnit ?? ''}  type=${c.calendarType ?? '?'}`);
  const url = `${base}/calendars/${c.id}/free-slots?startDate=${start}&endDate=${end}`;
  const res = await fetch(url, { headers });
  if (!res.ok) {
    console.log(`   free-slots falló: ${res.status} ${(await res.text()).slice(0, 200)}`);
    continue;
  }
  const body = await res.json();
  const byDay = Object.entries(body).filter(([k]) => /^\d{4}-\d{2}-\d{2}$/.test(k));
  if (byDay.length === 0) {
    console.log('   sin slots en la ventana');
    continue;
  }
  for (const [day, v] of byDay) {
    const slots = v.slots ?? [];
    if (slots.length === 0) continue;
    const wd = new Date(`${day}T12:00:00`).toLocaleDateString('es-MX', { weekday: 'short' });
    const t = (s) => s.slice(11, 16);
    const off = slots[0].slice(19);
    console.log(`   ${day} ${wd}: ${slots.length} slots, ${t(slots[0])} → ${t(slots[slots.length - 1])}  (offset ${off})`);
  }
}
