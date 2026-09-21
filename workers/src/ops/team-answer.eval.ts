/**
 * Manda por el canal del lead la respuesta que el equipo (o el cliente) dio a un
 * `pending_info`, y la deja registrada como lo que es: un mensaje de una persona
 * del equipo, no del bot.
 *
 *   TEAM_LOCATION=<ghl location id> TEAM_CONV=<ghl conversation id> \
 *   TEAM_FILE=<archivo con las burbujas, separadas por una línea en blanco> \
 *     pnpm exec vitest run src/ops/team-answer.eval.ts --fileParallelism=false
 *
 * Por defecto es DRY RUN. Agrega TEAM_SEND=1 para enviar de verdad, y
 * TEAM_CLEAR_TAGS=dato-pendiente para quitarle al contacto los tags de deuda al
 * terminar (el webhook de tags devuelve la conversación a `active` cuando ya no
 * queda ninguno — el handler los trata como UNA señal).
 *
 * Por qué registrar como `human_agent` y no como `bot`: el modelo lee esos
 * mensajes marcados `[Respuesta de una persona del equipo]` y los toma como la
 * respuesta oficial. Registrarlos como suyos lo hace repetir "déjame confirmarlo
 * con el equipo" sobre algo que el equipo ya contestó. Un envío crudo, sin
 * registrar, es peor todavía: el historial no lo tendría nunca.
 *
 * Nota: el envío sale por la API (`source:'api'`), así que el webhook de salida
 * lo descarta y NO abre la pausa de takeover humano — el bot sigue disponible
 * para contestar lo que responda el lead, que es justo lo que se quiere aquí.
 *
 * Es un archivo de vitest sólo para poder correr TypeScript; se auto-salta sin
 * TEAM_CONV, así que `pnpm eval` nunca lo toca.
 */

import { describe, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

await vi.hoisted(async () => {
  const { loadDotEnv } = await import('../battery/dotenv.js');
  loadDotEnv();
});

const CONV = process.env.TEAM_CONV;
const LOCATION = process.env.TEAM_LOCATION;
const FILE = process.env.TEAM_FILE;
const SEND = process.env.TEAM_SEND === '1';
const CLEAR_TAGS = (process.env.TEAM_CLEAR_TAGS ?? '').split(',').map((s) => s.trim()).filter(Boolean);

describe.skipIf(!CONV || !LOCATION)('respuesta del equipo', () => {
  it('manda las burbujas y las registra como del equipo', { timeout: 300_000 }, async () => {
    const { resolveTenant } = await import('../core/tenant.js');
    const { getSupabase } = await import('../db/client.js');
    const { logMessage, markDelivered } = await import('../db/queries.js');
    const { GhlClient } = await import('../ghl/client.js');

    if (!FILE) throw new Error('falta TEAM_FILE');
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

    console.log('\n--- respuesta del equipo ---');
    console.log('tenant   :', tenant.tenantId, '| canal:', conv.channel, '| status:', conv.status);
    console.log('contacto :', conv.ghl_contact_id);
    console.log('burbujas :', bubbles.length);
    bubbles.forEach((b, i) => console.log(`\n[${i + 1}]\n${b}`));
    console.log('\ntags a quitar:', CLEAR_TAGS.join(', ') || 'ninguno');
    console.log('acción   :', SEND ? 'ENVIAR' : 'DRY RUN (nada se envía)');
    console.log('----------------------------\n');

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
        p_sender_type: 'human_agent',
        p_content: text,
        p_agent_role: null,
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
      if (messageId) await markDelivered(messageId);
      console.log(`[equipo] burbuja ${i + 1}/${bubbles.length} enviada (ghl=${ghlMessageId})`);
    }

    if (CLEAR_TAGS.length) {
      await ghl.removeContactTags(conv.ghl_contact_id as string, CLEAR_TAGS);
      console.log('[equipo] tags quitados:', CLEAR_TAGS.join(', '));
    }
  });
});
