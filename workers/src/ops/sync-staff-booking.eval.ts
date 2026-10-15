/**
 * Paridad manual con una cita agendada por el equipo en GHL cuando el workflow
 * "Customer Booked Appointment" no la trajo: deja la conversación en el mismo
 * estado en que la deja una cita hecha por el bot (fila en `appointments`,
 * outcome, nudges cancelados, ronda 0, status completed + tag, CAPI, tags).
 *
 *   SYNC_LOCATION=<ghl location id> SYNC_CONV=<ghl conversation id> \
 *     pnpm exec vitest run src/ops/sync-staff-booking.eval.ts --fileParallelism=false
 *
 * DRY RUN por defecto; SYNC_APPLY=1 escribe. Se auto-salta sin SYNC_CONV.
 */
import { describe, it, vi } from 'vitest';

await vi.hoisted(async () => {
  const { loadDotEnv } = await import('../battery/dotenv.js');
  loadDotEnv();
});

const CONV = process.env.SYNC_CONV;
const LOCATION = process.env.SYNC_LOCATION;
const APPLY = process.env.SYNC_APPLY === '1';

describe.skipIf(!CONV || !LOCATION)('paridad con cita del equipo', () => {
  it('deja la conversación como si el bot hubiera agendado', { timeout: 120_000 }, async () => {
    const { resolveTenant } = await import('../core/tenant.js');
    const { getSupabase } = await import('../db/client.js');
    const { logEvent, updateConversationStatus } = await import('../db/queries.js');
    const { GhlClient } = await import('../ghl/client.js');
    const { STATUS_TAGS } = await import('../ghl/tags.js');
    const { handleAppointmentWebhook } = await import('../worker/appointment-webhook-handler.js');
    const { queueCapiEvent } = await import('../meta/capi.js');

    const tenant = await resolveTenant(LOCATION!);
    if (!tenant) throw new Error(`sin tenant para location ${LOCATION}`);
    const supabase = getSupabase();
    const { data: conv, error } = await supabase
      .from('conversations')
      .select('id, ghl_contact_id, status, contact_phone, outcome')
      .eq('ghl_conversation_id', CONV!)
      .single();
    if (error || !conv) throw new Error(`no pude leer la conversación: ${error?.message}`);

    const ghl = new GhlClient(tenant.tenantId);
    const events = await ghl.getContactAppointments(conv.ghl_contact_id as string, tenant.config.timezone);
    const upcoming = events
      .filter((e) => !e.deleted && e.status !== 'cancelled' && e.startTime && Date.parse(e.startTime) > Date.now())
      .sort((a, b) => Date.parse(a.startTime!) - Date.parse(b.startTime!));
    console.log('citas en GHL:', JSON.stringify(events, null, 2));
    if (upcoming.length !== 1) throw new Error(`esperaba 1 cita próxima, hay ${upcoming.length}`);
    const appt = upcoming[0]!;
    console.log('cita elegida:', appt.id, appt.startTime, appt.title, '| status conv:', conv.status, '| outcome:', conv.outcome);
    if (!APPLY) return console.log('DRY RUN — nada escrito');

    const secret = 'manual-sync';
    const res = await handleAppointmentWebhook(
      { locationId: LOCATION, contactId: conv.ghl_contact_id, appointmentId: appt.id, action: 'booked' },
      `Bearer ${secret}`,
      secret,
    );
    console.log('handler:', JSON.stringify(res));

    await logEvent({
      p_client_id: tenant.clientId,
      p_ghl_conversation_id: CONV!,
      p_event_type: 'lead_qualified',
      p_metadata: { service: appt.title ?? null, startTime: appt.startTime, via: 'manual-sync' },
    });
    const applied = await updateConversationStatus(CONV!, 'completed');
    console.log('status completed applied:', applied);
    if (applied && STATUS_TAGS.completed) await ghl.addContactTags(conv.ghl_contact_id as string, [STATUS_TAGS.completed]);
    await queueCapiEvent({
      tenant,
      ghlConversationId: CONV!,
      kind: 'appointment_booked',
      phone: (conv.contact_phone as string | null) ?? null,
    });
    console.log('listo');
  });
});
