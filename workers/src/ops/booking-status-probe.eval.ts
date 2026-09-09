/**
 * Sonda de "cita No confirmada" (0061) contra el GHL REAL de un tenant.
 *
 * Contesta las dos preguntas que no se pueden contestar desde los tests:
 *   1. ¿`appointmentStatus: 'new'` se ve como "No confirmada" al leerla de vuelta?
 *   2. ¿Una cita sin confirmar OCUPA el espacio, o el calendario lo sigue ofreciendo?
 *
 * Por defecto es DRY RUN: sólo lista los slots del día pedido y dice cuál usaría.
 * Con PROBE_RUN=1 aparta el slot, lo relee, vuelve a pedir los slots, y BORRA la
 * cita (DELETE, no cancelación: no deja fila cancelada ni tag en el contacto) y
 * confirma que el hueco regresó. La ventana de exposición son segundos.
 *
 *   PROBE_LOCATION=<ghl location id> PROBE_CALENDAR=<calendar id> PROBE_CONTACT=<contact id> \
 *     [PROBE_DAYS=1] [PROBE_SLOT=<ISO exacto>] [PROBE_RUN=1] [PROBE_KEEP=1] \
 *     pnpm exec vitest run src/ops/booking-status-probe.eval.ts --fileParallelism=false
 *
 * `toNotify: false` a propósito: es lo único que se aparta del payload de
 * producción, para no mandarle notificaciones al equipo del cliente por una prueba.
 * Archivo de vitest sólo para correr TypeScript; se auto-salta sin PROBE_LOCATION.
 */

import { describe, it, vi } from 'vitest';

await vi.hoisted(async () => {
  const { loadDotEnv } = await import('../battery/dotenv.js');
  loadDotEnv();
});

const LOCATION = process.env.PROBE_LOCATION;
const CALENDAR = process.env.PROBE_CALENDAR;
const CONTACT = process.env.PROBE_CONTACT;
const DAYS = Number(process.env.PROBE_DAYS ?? '1');
const SLOT = process.env.PROBE_SLOT;
const RUN = process.env.PROBE_RUN === '1';
const KEEP = process.env.PROBE_KEEP === '1';

describe.skipIf(!LOCATION || !CALENDAR)('sonda de cita sin confirmar', () => {
  it('aparta, lee el status, mide la ocupación y limpia', { timeout: 180_000 }, async () => {
    const { getSupabase } = await import('../db/client.js');
    const { GhlClient } = await import('../ghl/client.js');

    // Select angosto a propósito, no loadTenantConfig: la sonda sólo necesita zona y
    // nombre, y así corre igual antes y después de una migración de tenant_config.
    const { data: row, error } = await getSupabase()
      .from('tenants')
      .select('id, tenant_config(business_name, timezone)')
      .eq('ghl_location_id', LOCATION!)
      .single();
    if (error || !row) throw new Error(`sin tenant para location ${LOCATION}: ${error?.message}`);
    const cfg = (Array.isArray(row.tenant_config) ? row.tenant_config[0] : row.tenant_config) as { business_name: string; timezone: string };
    const tz = cfg.timezone;
    const ghl = new GhlClient(row.id as string);

    const label = (iso: string) =>
      new Intl.DateTimeFormat('es-MX', {
        weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit',
        timeZone: tz,
      }).format(new Date(iso));

    // Ventana = el día natural (zona del tenant) a DAYS días de hoy.
    const dayStart = new Date(Date.now() + DAYS * 86_400_000);
    const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(dayStart);
    const from = new Date(`${ymd}T00:00:00Z`).toISOString();
    const to = new Date(Date.parse(from) + 2 * 86_400_000).toISOString();

    const before = await ghl.getAvailability(CALENDAR!, from, to);
    const sameDay = before.filter((s) => s.start.slice(0, 10) === ymd || label(s.start).includes(ymd.slice(8)));
    console.log(`\n=== ${cfg.business_name} · calendario ${CALENDAR} · ${tz}`);
    console.log(`Slots libres para el ${ymd} (${sameDay.length} de ${before.length} en la ventana):`);
    for (const s of sameDay) console.log(`   ${s.start}   →   ${label(s.start)}`);

    const target = SLOT ?? sameDay.at(-1)?.start;
    if (!target) throw new Error('no hay slots libres ese día: elige otro PROBE_DAYS o pasa PROBE_SLOT');
    console.log(`\nSlot elegido: ${target}  (${label(target)})`);
    if (!before.some((s) => s.start === target)) {
      console.log('⚠️  OJO: ese slot NO viene en la lista de libres — GHL puede rechazar la reserva.');
    }

    if (!RUN) {
      console.log('\nDRY RUN — no se apartó nada. Repite con PROBE_RUN=1 para hacer la prueba real.\n');
      return;
    }
    if (!CONTACT) throw new Error('PROBE_RUN=1 necesita PROBE_CONTACT (el contacto de prueba)');

    // Reserva: el payload de producción con appointmentStatus 'new' (0061).
    const { ghlAppointmentId } = await ghl.bookAppointment({
      calendarId: CALENDAR!,
      locationId: LOCATION!,
      contactId: CONTACT,
      startTime: target,
      title: 'PRUEBA — cita sin confirmar (borrar)',
      appointmentStatus: 'new',
    });
    console.log(`\n① Apartada: ${ghlAppointmentId}`);

    try {
      const live = await ghl.getAppointment(ghlAppointmentId);
      console.log(`② Status que GHL reporta: ${JSON.stringify(live)}`);
      console.log(`   ${live.status === 'new' ? '✅ "new" = No confirmada' : `❌ esperaba 'new', llegó '${live.status}'`}`);

      const after = await ghl.getAvailability(CALENDAR!, from, to);
      const stillOffered = after.some((s) => s.start === target);
      console.log(`③ ¿El calendario sigue ofreciendo ese horario? ${stillOffered ? '❌ SÍ — una cita sin confirmar NO ocupa el espacio' : '✅ NO — la cita sin confirmar ocupa el espacio'}`);
      console.log(`   libres antes: ${before.length} · libres ahora: ${after.length}`);
    } finally {
      if (KEEP) {
        console.log(`\n⚠️  PROBE_KEEP=1: la cita ${ghlAppointmentId} SIGUE en el calendario. Bórrala a mano.`);
      } else {
        await deleteAppointment(ghl, ghlAppointmentId);
        const restored = await ghl.getAvailability(CALENDAR!, from, to);
        console.log(`④ Cita borrada. ¿Regresó el hueco? ${restored.some((s) => s.start === target) ? '✅ sí' : '⚠️ no (revísalo en el calendario)'} · libres: ${restored.length}\n`);
      }
    }
  });
});

/** DELETE /calendars/events/{id} — borra el evento en vez de dejarlo cancelado.
 *  No vive en GhlClient porque el bot nunca borra citas: sólo las cancela. */
async function deleteAppointment(ghl: unknown, appointmentId: string): Promise<void> {
  const client = ghl as { getAccessToken(): Promise<string>; apiBase: string };
  const token = await client.getAccessToken();
  const res = await fetch(`${client.apiBase}/calendars/events/${appointmentId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}`, Version: '2021-04-15' },
  });
  if (!res.ok) throw new Error(`[probe] no pude borrar la cita ${appointmentId}: ${res.status} ${await res.text()}`);
}
