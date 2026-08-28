/**
 * Prepara (o cierra) una toma del demo de bótox para grabar video.
 *
 * El demo manual normalmente se enciende escribiendo `demo botox` en el chat — y esa
 * palabra queda a cuadro. Este script hace el mismo flip desde la DB
 * (`active_role='demo'` + `role_started_at=now()`), así el primer mensaje que se ve en
 * pantalla ya es el del lead que llega del anuncio, y el bot no arrastra la toma anterior:
 * el historial se carga desde `role_started_at`, así que re-armar = borrón y cuenta nueva
 * para el modelo (la pantalla la limpias tú con "Vaciar chat" en WhatsApp).
 *
 * Uso, desde workers/ con el .env cargado:
 *   node scripts/demo-take.mjs            # arma la toma
 *   node scripts/demo-take.mjs --show     # solo enseña el estado
 *   node scripts/demo-take.mjs --off      # sale del demo (vuelve Sara)
 *   node scripts/demo-take.mjs --phone 385034   # otro número de prueba
 */
import { createClient } from '@supabase/supabase-js';

/** The Bot Crew — ver docs/onboarding.md; el demo vive en su tenant. */
const BOT_CREW_CLIENT_ID = 'd1b0823f-ceee-45e2-aa82-7173fe58d4e0';

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const has = (name) => argv.includes(`--${name}`);

const clientId = flag('client', BOT_CREW_CLIENT_ID);
// El teléfono de prueba se guarda con y sin el `1` mexicano: siempre se busca por fragmento.
const phoneFragment = flag('phone', '385034');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const { data: rows, error } = await supabase
  .from('conversations')
  .select('id, ghl_conversation_id, ghl_contact_id, channel, status, active_role, role_started_at, human_active_until, contact_phone')
  .eq('client_id', clientId)
  .like('contact_phone', `%${phoneFragment}%`)
  .order('started_at', { ascending: false })
  .limit(1);

if (error) {
  console.error('no se pudo leer conversations:', error.message);
  process.exit(1);
}
const conv = rows?.[0];
if (!conv) {
  console.error(`no hay conversación para el teléfono %${phoneFragment}% en ese cliente.`);
  console.error('manda un mensaje desde ese número primero: la fila nace con el primer inbound.');
  process.exit(1);
}

const show = (c) =>
  console.log(
    `conv=${c.ghl_conversation_id} contacto=${c.ghl_contact_id} canal=${c.channel}\n` +
      `  estado=${c.status} persona=${c.active_role ?? 'normal (Sara)'} desde=${c.role_started_at ?? '—'}` +
      (c.human_active_until && Date.parse(c.human_active_until) > Date.now()
        ? `\n  ⚠️ pausa humana activa hasta ${c.human_active_until} — el bot no va a contestar`
        : ''),
  );

if (has('show')) {
  show(conv);
  process.exit(0);
}

if (has('off')) {
  const { error: e } = await supabase
    .from('conversations')
    .update({ active_role: null, role_started_at: null, demo_started_at: null })
    .eq('id', conv.id);
  if (e) {
    console.error('no se pudo salir del demo:', e.message);
    process.exit(1);
  }
  console.log('demo apagado — vuelve la persona normal (Sara).');
  process.exit(0);
}

// Armar: el flip + arranque limpio. `status='active'` y la pausa humana en null porque
// una toma anterior pudo dejar la conversación en standby o con el bot callado.
const now = new Date().toISOString();
const { error: e } = await supabase
  .from('conversations')
  .update({
    active_role: 'demo',
    role_started_at: now,
    demo_started_at: now,
    status: 'active',
    human_active_until: null,
    handoff_triggered: false,
    outcome: null,
    prompt_variant: null,
  })
  .eq('id', conv.id);
if (e) {
  console.error('no se pudo armar el demo:', e.message);
  process.exit(1);
}

show({ ...conv, active_role: 'demo', role_started_at: now, status: 'active', human_active_until: null });
console.log(`
Toma lista. Limpia la pantalla ("Vaciar chat" en WhatsApp) y escribe, desde el número de prueba:

  1) Hola! vi su anuncio del bótox, me pueden dar informes?
     → Vale saluda y pregunta la zona. Sin horarios todavía.

  2) Sí, es mi primera vez y me interesa el entrecejo. ¿Puedo ir esta semana en la tarde?
     → contesta y ofrece 2 horarios reales del calendario simulado.

  3) Perfecto, el <día y hora que te ofreció> me queda bien
     → "agenda" la valoración y confirma con ese mismo texto.

Sin efectos reales: la cita es simulada (no toca GHL), no se agenda nada, no se manda CAPI,
no hay follow-ups ni etiquetas. Para otra toma, vuelve a correr este script.
Al terminar: node scripts/demo-take.mjs --off
`);
