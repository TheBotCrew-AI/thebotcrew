/**
 * Mensaje proactivo del bot en un hilo que no espera respuesta: el lead no
 * escribió nada nuevo, así que no hay turno que rescatar (`rescue-turn`) ni
 * respuesta del equipo que registrar (`team-answer`). El caso típico es un
 * no-show: la cita pasó, nadie llegó, y queremos reabrir la conversación
 * ofreciendo reagendar — con la voz del bot, para que siga siendo él quien
 * lleva el hilo cuando el lead conteste.
 *
 *   OUTREACH_LOCATION=<ghl location id> OUTREACH_CONV=<ghl conversation id> \
 *   OUTREACH_FILE=<archivo con las burbujas, separadas por una línea en blanco> \
 *     pnpm exec vitest run src/ops/bot-outreach.eval.ts --fileParallelism=false
 *
 * Por defecto es DRY RUN. Agrega OUTREACH_SEND=1 para enviar de verdad.
 *
 * Por qué registrar como `bot` y no como `human_agent`: el modelo lee los
 * mensajes marcados `[Respuesta de una persona del equipo]` como la respuesta
 * oficial de alguien más. Estas burbujas son suyas — si las registráramos como
 * del equipo, en el siguiente turno hablaría como si otra persona ya hubiera
 * ofrecido reagendar. `p_model` va en NULL a propósito: no salieron de una
 * llamada al modelo y no hay tokens que atribuirles.
 *
 * El envío sale por la API (`source:'api'`), así que el webhook de salida lo
 * descarta y NO abre la pausa de takeover humano — el bot sigue disponible para
 * contestar lo que responda el lead, que es justo lo que se quiere aquí.
 *
 * Ojo con la ventana de 24 h de WhatsApp: si el último mensaje del lead tiene
 * más de un día, Meta ya sólo acepta plantillas y el envío libre falla. El
 * script la calcula y avisa antes de mandar.
 *
 * Es un archivo de vitest sólo para poder correr TypeScript; se auto-salta sin
 * OUTREACH_CONV, así que `pnpm eval` nunca lo toca.
 */

import { describe, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

await vi.hoisted(async () => {
  const { loadDotEnv } = await import('../battery/dotenv.js');
  loadDotEnv();
});

const CONV = process.env.OUTREACH_CONV;
const LOCATION = process.env.OUTREACH_LOCATION;
const FILE = process.env.OUTREACH_FILE;
const SEND = process.env.OUTREACH_SEND === '1';

describe.skipIf(!CONV || !LOCATION)('mensaje proactivo del bot', () => {
  it('manda las burbujas y las registra como del bot', { timeout: 300_000 }, async () => {
    const { resolveTenant } = await import('../core/tenant.js');
    const { getSupabase } = await import('../db/client.js');
    const { logMessage, markDelivered, setGhlMessageId } = await import('../db/queries.js');
    const { GhlClient } = await import('../ghl/client.js');
    const { FRONT_DESK_ROLE } = await import('../roles/front-desk/agent.js');

    if (!FILE) throw new Error('falta OUTREACH_FILE');
    const bubbles = readFileSync(FILE, 'utf8').split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
    if (bubbles.length === 0) throw new Error(`${FILE} no tiene ninguna burbuja`);

    const tenant = await resolveTenant(LOCATION!);
    if (!tenant) throw new Error(`sin tenant para location ${LOCATION}`);

    const supabase = getSupabase();
    const { data: conv, error } = await supabase
      .from('conversations')
      .select('id, ghl_contact_id, channel, status, contact_phone')
      .eq('ghl_conversation_id', CONV!)
      .single();
    if (error || !conv) throw new Error(`no pude leer la conversación: ${error?.message}`);

    const { data: lastIn } = await supabase
      .from('messages')
      .select('sent_at')
      .eq('conversation_id', conv.id as string)
      .eq('direction', 'inbound')
      .order('sent_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    const hoursSinceInbound = lastIn?.sent_at
      ? (Date.now() - new Date(lastIn.sent_at as string).getTime()) / 3_600_000
      : null;

    console.log('\n--- mensaje proactivo ---');
    console.log('tenant   :', tenant.tenantId, '| canal:', conv.channel, '| status:', conv.status);
    console.log('contacto :', conv.ghl_contact_id);
    console.log(
      'ventana  :',
      hoursSinceInbound === null
        ? 'sin mensajes del lead'
        : `${hoursSinceInbound.toFixed(1)} h desde el último mensaje del lead` +
          (conv.channel === 'whatsapp' && hoursSinceInbound >= 24 ? ' — ⚠️ la ventana de 24 h ya cerró' : ''),
    );
    console.log('burbujas :', bubbles.length);
    bubbles.forEach((b, i) => console.log(`\n[${i + 1}]\n${b}`));
    console.log('\nacción   :', SEND ? 'ENVIAR' : 'DRY RUN (nada se envía)');
    console.log('-------------------------\n');

    if (!SEND) return;

    const ghl = new GhlClient(tenant.tenantId);
    const phone = (conv.contact_phone as string | null) ?? undefined;

    for (const [i, text] of bubbles.entries()) {
      // Pausa entre burbujas: llegan en orden y se leen como escritas, no como un volcado.
      if (i > 0) await new Promise<void>((r) => setTimeout(r, 3000));

      const { messageId } = await logMessage({
        p_ghl_conversation_id: CONV!,
        p_client_id: tenant.clientId,
        p_channel: conv.channel as string,
        p_ghl_contact_id: conv.ghl_contact_id as string,
        p_contact_phone: phone ?? null,
        p_direction: 'outbound',
        p_sender_type: 'bot',
        p_content: text,
        p_agent_role: FRONT_DESK_ROLE,
        p_human_agent_id: null,
        p_model: null,
        p_sent_at: null,
      });

      const { ghlMessageId } = await ghl.sendMessage({
        contactId: conv.ghl_contact_id as string,
        channel: conv.channel as never,
        text,
        phone,
        conversationId: CONV!,
      });
      if (messageId) {
        if (ghlMessageId) await setGhlMessageId(messageId, ghlMessageId);
        await markDelivered(messageId);
      }
      console.log(`[bot] burbuja ${i + 1}/${bubbles.length} enviada (ghl=${ghlMessageId})`);
    }
  });
});
