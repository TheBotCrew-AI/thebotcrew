/**
 * Rescate manual de un turno: hace que el bot conteste un mensaje entrante que
 * quedó sin respuesta (típicamente porque el gate de `trigger_keywords` lo dejó
 * fuera y después se decidió, a mano, que ese lead sí entra).
 *
 * Corre el turno REAL (`runAgentTurn`) contra la config viva y el GHL real, así
 * que hereda todo lo del pipeline normal: historial, tags, cadencia de nudges,
 * CAPI, clasificación de status. Un envío por script fuera de este camino NO
 * arma nada de eso.
 *
 *   RESCUE_LOCATION=<ghl location id> RESCUE_CONV=<ghl conversation id> \
 *     pnpm exec vitest run src/ops/rescue-turn.eval.ts --fileParallelism=false
 *
 * Por defecto es DRY RUN: imprime a quién le hablaría y qué haría, sin enviar.
 * Agrega RESCUE_SEND=1 para ejecutarlo de verdad, y RESCUE_ACTIVATE=1 para
 * además levantar `bot_activated` (necesario si el gate de keywords lo bloqueó,
 * o la conversación se vuelve a gatear en el siguiente mensaje).
 *
 * Es un archivo de vitest sólo para poder correr TypeScript; se auto-salta sin
 * RESCUE_CONV, así que `pnpm eval` nunca lo toca.
 */

import { describe, it, vi } from 'vitest';

await vi.hoisted(async () => {
  const { loadDotEnv } = await import('../battery/dotenv.js');
  loadDotEnv();
});

const CONV = process.env.RESCUE_CONV;
const LOCATION = process.env.RESCUE_LOCATION;
const SEND = process.env.RESCUE_SEND === '1';
const ACTIVATE = process.env.RESCUE_ACTIVATE === '1';

describe.skipIf(!CONV || !LOCATION)('rescate de turno', () => {
  it('contesta el último mensaje sin responder', { timeout: 300_000 }, async () => {
    const { resolveTenant } = await import('../core/tenant.js');
    const { getSupabase } = await import('../db/client.js');
    const { botActivation, logBotEvent } = await import('../db/queries.js');
    const { GhlClient } = await import('../ghl/client.js');
    const { buildFrontDeskAgent } = await import('../roles/front-desk/agent.js');
    const { runAgentTurn } = await import('../worker/webhook-handler.js');

    const tenant = await resolveTenant(LOCATION!);
    if (!tenant) throw new Error(`sin tenant para location ${LOCATION}`);

    const supabase = getSupabase();
    const { data: conv, error: convErr } = await supabase
      .from('conversations')
      .select('id, ghl_contact_id, channel, status, bot_activated, prompt_variant, contact_phone')
      .eq('ghl_conversation_id', CONV!)
      .single();
    if (convErr || !conv) throw new Error(`no pude leer la conversación: ${convErr?.message}`);

    // El último mensaje del hilo tiene que ser del lead: si ya hay algo después
    // (el bot o una persona del equipo), no hay nada que rescatar. A diferencia de
    // findUnansweredInbound NO miramos `turn_scheduled`: aquí ese evento existe
    // justamente porque el turno se programó y el gate lo tiró.
    const { data: msg, error: msgErr } = await supabase
      .from('messages')
      .select('id, content, sender_type, sent_at, ghl_message_id')
      .eq('conversation_id', conv.id as string)
      .order('sent_at', { ascending: false })
      .limit(1)
      .single();
    if (msgErr || !msg) throw new Error(`no pude leer el mensaje: ${msgErr?.message}`);
    if (msg.sender_type !== 'lead') {
      throw new Error(`el último mensaje de ${CONV} es de "${msg.sender_type}" — ya alguien contestó`);
    }

    const ghl = new GhlClient(tenant.tenantId);
    const contact = await ghl.getContact(conv.ghl_contact_id as string);

    console.log('\n--- rescate ---');
    console.log('tenant     :', tenant.tenantId);
    const displayName =
      contact?.name ?? [contact?.firstName, contact?.lastName].filter(Boolean).join(' ') ?? '';
    console.log('contacto   :', displayName || '(sin nombre)', `(${conv.ghl_contact_id})`);
    console.log('canal      :', conv.channel, '| status:', conv.status, '| bot_activated:', conv.bot_activated);
    console.log('variante   :', conv.prompt_variant ?? '(base)');
    console.log('mensaje    :', JSON.stringify(msg.content));
    console.log('recibido   :', msg.sent_at);
    console.log('acción     :', SEND ? (ACTIVATE ? 'activar + contestar' : 'contestar') : 'DRY RUN (nada se envía)');
    console.log('---------------\n');

    if (!SEND) return;

    if (ACTIVATE) {
      const state = await botActivation(conv.id as string, true);
      // El handler del webhook loggea este evento cuando la keyword abre la puerta;
      // aquí la abrimos a mano, así que la línea de tiempo lo tiene que decir.
      if (state === 'activated') {
        await logBotEvent(tenant.clientId, CONV!, 'bot_activated', { via: 'manual-rescue' });
      }
      console.log('[rescate] bot_activated →', state);
    }

    const result = await runAgentTurn({
      agent: buildFrontDeskAgent(),
      conversationId: conv.id as string,
      messageId: msg.id as string,
      tenant,
      parsed: {
        locationId: LOCATION!,
        contactId: conv.ghl_contact_id as string,
        conversationId: CONV!,
        channel: conv.channel as never,
        text: (msg.content as string) ?? '',
        phone: (conv.contact_phone as string | null) ?? undefined,
        messageId: (msg.ghl_message_id as string | null) ?? undefined,
        attachments: [],
      },
      phone: (conv.contact_phone as string | null) ?? undefined,
      debounced: false,
    });
    console.log('[rescate] resultado:', JSON.stringify(result, null, 2));
  });
});
