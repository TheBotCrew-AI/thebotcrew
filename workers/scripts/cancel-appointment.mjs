/**
 * Cancela una cita de GHL SIN avisarle al contacto (toNotify:false) — para limpiar la
 * cita real que deja una prueba del bot en el calendario de Leo. Muestra la cita antes de
 * tocarla. La fila de `appointments` en Supabase se limpia aparte (ver la nota de memoria
 * del hilo de prueba): borrar la fila primero deja la junta viva en el calendario.
 *
 * Uso: node scripts/cancel-appointment.mjs <tenantId> <appointmentId>
 * Necesita .env cargado (SUPABASE_*, GHL_CLIENT_ID/SECRET para refrescar el token).
 * Nunca imprime el token.
 */
import { createClient } from '@supabase/supabase-js';
const [tenantId, appointmentId] = process.argv.slice(2);
if (!tenantId || !appointmentId) {
  console.error('uso: node scripts/cancel-appointment.mjs <tenantId> <appointmentId>');
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
const headers = { Authorization: `Bearer ${token}`, Version: '2021-04-15', 'Content-Type': 'application/json' };
const base = 'https://services.leadconnectorhq.com/calendars/events/appointments';

const got = await fetch(`${base}/${appointmentId}`, { headers });
if (!got.ok) {
  console.error(`cita ${appointmentId}: no se pudo leer (HTTP ${got.status}) ${(await got.text()).slice(0, 200)}`);
  process.exit(2);
}
const appt = (await got.json())?.appointment ?? (await Promise.resolve({}));
console.log(`cita ${appointmentId}: "${appt.title ?? '?'}" ${appt.startTime ?? '?'} estado=${appt.appointmentStatus ?? appt.status ?? '?'} contacto=${appt.contactId ?? '?'}`);
if ((appt.appointmentStatus ?? appt.status) === 'cancelled') {
  console.log('ya estaba cancelada');
  process.exit(0);
}
const put = await fetch(`${base}/${appointmentId}`, {
  method: 'PUT',
  headers,
  body: JSON.stringify({ appointmentStatus: 'cancelled', toNotify: false }),
});
console.log(put.ok ? 'cancelada (sin notificar)' : `falló cancelar: ${put.status} ${(await put.text()).slice(0, 200)}`);
process.exit(put.ok ? 0 : 1);
