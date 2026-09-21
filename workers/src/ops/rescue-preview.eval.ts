/**
 * Vista previa de un rescate: genera lo que el bot LE CONTESTARÍA al último
 * mensaje sin responder de una conversación real, sin mandar nada y sin escribir
 * en la base. Para revisar el mensaje antes de correr `rescue-turn.eval.ts`.
 *
 *   RESCUE_LOCATION=<ghl location id> RESCUE_CONV=<ghl conversation id> \
 *     pnpm exec vitest run src/ops/rescue-preview.eval.ts --fileParallelism=false
 *
 * Corre el agente REAL sobre la config VIVA del tenant y el historial REAL de la
 * conversación (lectura), pero contra el GHL falso de la batería (calendario con
 * el horario real del tenant, que no es de nadie) y con toda escritura a la DB
 * stubbeada: una query no prevista LANZA en vez de llegar a prod. Por eso los
 * horarios que proponga son plausibles, no los de la agenda de verdad — lo que
 * se revisa aquí es el TONO y el CONTENIDO, no el slot.
 *
 * Es un archivo de vitest sólo para poder mockear; se auto-salta sin RESCUE_CONV.
 */

import { describe, it, vi } from 'vitest';
import type { ModelMessage } from 'ai';

await vi.hoisted(async () => {
  const { loadDotEnv } = await import('../battery/dotenv.js');
  loadDotEnv();
});

const shared = vi.hoisted(() => ({ ghl: null as null | Record<string, unknown> }));

vi.mock('../ghl/client.js', () => ({
  GhlClient: vi.fn(() => {
    if (!shared.ghl) throw new Error('preview: FakeGhl no está armado');
    return shared.ghl;
  }),
}));

// Las dos lecturas que sí son reales (config viva + historial real) pasan; todo lo
// que escribe queda stubbeado, y lo que no está previsto lanza.
vi.mock('../db/queries.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../db/queries.js')>();
  const ghl = () => shared.ghl as unknown as import('../battery/fake-ghl.js').FakeGhl;
  const passthrough = new Set(['loadTenantConfig', 'loadRecentMessages']);
  const stubs: Record<string, (...args: never[]) => unknown> = {
    logBotEvent: async () => undefined,
    logEvent: async () => ({ eventId: 'evt_preview' }),
    logLlmUsage: async () => undefined,
    getActiveDemoSession: async () => null,
    createDemoSession: async () => ({ sessionId: 'demo_preview' }),
    setSimulatedBooking: async () => undefined,
    setLeadTimezone: async () => undefined,
    updateConversationStatus: async () => true,
    reactivateConversation: async () => undefined,
    resetReactivationRound: async () => undefined,
    cancelFollowUps: async () => undefined,
    scheduleFollowUp: async () => undefined,
    loadAppointmentLog: async () => ghl().appointmentLog,
    logAppointment: async () => ({ appointmentId: 'appt_preview' }),
  };
  const out: Record<string, unknown> = {};
  for (const name of Object.keys(real)) {
    out[name] = passthrough.has(name)
      ? real[name as keyof typeof real]
      : stubs[name] ??
        (() => {
          throw new Error(`preview: la query "${name}" no está fakeada — stubbéala antes de que toque prod`);
        });
  }
  return out;
});

const CONV = process.env.RESCUE_CONV;
const LOCATION = process.env.RESCUE_LOCATION;

describe.skipIf(!CONV || !LOCATION)('vista previa del rescate', () => {
  it('genera la respuesta sin enviarla', { timeout: 300_000 }, async () => {
    const { loadRecentMessages } = await import('../db/queries.js');
    const { resolveTenant } = await import('../core/tenant.js');
    const { getSupabase } = await import('../db/client.js');
    const { resolveAiApiKey } = await import('../core/env.js');
    const { toModelMessages, hasHumanReplies } = await import('../core/model-messages.js');
    const { buildAgentRequestContext } = await import('../core/runtime-context.js');
    const { parseFrontDeskConfig } = await import('../roles/front-desk/config.js');
    const { DEFAULT_MODEL, DEFAULT_PROVIDER, buildFrontDeskAgent } = await import('../roles/front-desk/agent.js');
    const { splitIntoMessages } = await import('../worker/webhook-handler.js');
    const { FakeGhl } = await import('../battery/fake-ghl.js');
    const type = await import('../core/types.js');
    void type;

    const tenant = await resolveTenant(LOCATION!);
    if (!tenant) throw new Error(`sin tenant para location ${LOCATION}`);

    const supabase = getSupabase();
    const { data: conv, error: convErr } = await supabase
      .from('conversations')
      .select('id, ghl_contact_id, channel, status, bot_activated, prompt_variant, active_role, role_started_at, lead_timezone, contact_phone')
      .eq('ghl_conversation_id', CONV!)
      .single();
    if (convErr || !conv) throw new Error(`no pude leer la conversación: ${convErr?.message}`);

    const history = await loadRecentMessages(
      conv.id as string,
      20,
      (conv.role_started_at as string | null) ?? undefined,
    );
    const last = history[history.length - 1];
    if (!last || last.senderType !== 'lead') {
      throw new Error(`el último mensaje es de "${last?.senderType ?? 'nadie'}" — no hay nada que previsualizar`);
    }

    const config = parseFrontDeskConfig(tenant.config);
    shared.ghl = new FakeGhl({
      timezone: config.timezone,
      hours: config.hours,
      phone: (conv.contact_phone as string | null) ?? undefined,
    }) as unknown as Record<string, unknown>;

    const provider = tenant.config.provider ?? DEFAULT_PROVIDER;
    const model = tenant.config.model ?? DEFAULT_MODEL;
    const aiKey = resolveAiApiKey(provider, tenant.config.aiKeyRef);

    const requestContext = buildAgentRequestContext({
      tenant,
      turn: {
        ghlConversationId: CONV!,
        ghlContactId: conv.ghl_contact_id as string,
        contactPhone: (conv.contact_phone as string | null) ?? undefined,
        channel: conv.channel as never,
        activeRole: (conv.active_role as string | null) ?? undefined,
        promptVariant: (conv.prompt_variant as string | null) ?? undefined,
        leadTimezone: (conv.lead_timezone as string | null) ?? undefined,
        hasHumanReplies: hasHumanReplies(history),
      },
      provider,
      model,
      llmApiKey: aiKey.apiKey,
    });

    const messages = toModelMessages(history) as ModelMessage[];
    console.log('\n--- vista previa ---');
    console.log('tenant     :', tenant.tenantId, '| canal:', conv.channel, '| variante:', conv.prompt_variant ?? '(base)');
    console.log('modelo     :', `${provider}/${model}`, '| llave:', aiKey.source);
    console.log('historial  :', messages.length, 'mensaje/s | último del lead:', JSON.stringify(last.content));
    console.log('--------------------');

    const res = await agentGenerate();
    async function agentGenerate() {
      const agent = buildFrontDeskAgent();
      return agent.generate(messages, { requestContext, maxSteps: 8 });
    }

    const tools = (res.toolCalls ?? []).map((c: { payload: { toolName: string; args?: unknown } }) => c.payload.toolName);
    console.log('\n=== LO QUE CONTESTARÍA (nada se envió) ===');
    splitIntoMessages(res.text).forEach((b, i) => console.log(`\n[burbuja ${i + 1}]\n${b}`));
    console.log('\nherramientas:', tools.join(', ') || 'ninguna');
    console.log('=========================================\n');
  });
});
