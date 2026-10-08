/**
 * Sondeo de preguntas sueltas contra la config VIVA de un tenant — qué contesta el bot a
 * cada una, un turno por pregunta, sin historial. GHL y DB falsos (sólo la lectura de config
 * es real), así que nada se manda ni se escribe. Para revisar un FAQ recién cargado antes de
 * soltarle el demo a alguien.
 *
 *   FAQ_PROBE_LOCATION=<locationId> FAQ_PROBE_FILE=<preguntas.txt> pnpm exec vitest run src/ops/faq-probe.eval.ts --reporter=basic
 *
 * Escribe `<FAQ_PROBE_FILE>.out.md` junto al archivo de preguntas.
 */

import { describe, it, vi } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';

await vi.hoisted(async () => {
  const { loadDotEnv } = await import('../battery/dotenv.js');
  loadDotEnv();
});

const shared = vi.hoisted(() => ({ ghl: null as null | Record<string, unknown> }));

vi.mock('../ghl/client.js', () => ({
  GhlClient: vi.fn(() => {
    if (!shared.ghl) throw new Error('probe: FakeGhl no está armado');
    return shared.ghl;
  }),
}));

vi.mock('../db/queries.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../db/queries.js')>();
  const ghl = () => shared.ghl as unknown as import('../battery/fake-ghl.js').FakeGhl;
  const passthrough = new Set(['loadTenantConfig']);
  const stubs: Record<string, (...args: never[]) => unknown> = {
    logBotEvent: async () => undefined,
    logEvent: async () => ({ eventId: 'evt_probe' }),
    logLlmUsage: async () => undefined,
    getActiveDemoSession: async () => null,
    setLeadTimezone: async () => undefined,
    updateConversationStatus: async () => true,
    reactivateConversation: async () => undefined,
    resetReactivationRound: async () => undefined,
    cancelFollowUps: async () => undefined,
    scheduleFollowUp: async () => undefined,
    loadAppointmentLog: async () => ghl().appointmentLog,
    logAppointment: async () => ({ appointmentId: 'appt_probe' }),
    wasPrimeTimeReleased: async () => false,
  };
  const out: Record<string, unknown> = {};
  for (const name of Object.keys(real)) {
    out[name] = passthrough.has(name)
      ? real[name as keyof typeof real]
      : stubs[name] ??
        (() => {
          throw new Error(`probe: la query "${name}" no está fakeada — stubbéala antes de que toque prod`);
        });
  }
  return out;
});

const LOCATION = process.env.FAQ_PROBE_LOCATION;
const FILE = process.env.FAQ_PROBE_FILE;

describe.skipIf(!LOCATION || !FILE)('sondeo de preguntas', () => {
  it('contesta cada pregunta', { timeout: 900_000 }, async () => {
    const { resolveTenant } = await import('../core/tenant.js');
    const { resolveAiApiKey } = await import('../core/env.js');
    const { buildAgentRequestContext } = await import('../core/runtime-context.js');
    const { parseFrontDeskConfig } = await import('../roles/front-desk/config.js');
    const { DEFAULT_MODEL, DEFAULT_PROVIDER, buildFrontDeskAgent } = await import('../roles/front-desk/agent.js');
    const { FakeGhl } = await import('../battery/fake-ghl.js');

    const tenant = await resolveTenant(LOCATION!);
    if (!tenant) throw new Error(`sin tenant para location ${LOCATION}`);
    const config = parseFrontDeskConfig(tenant.config);
    const provider = tenant.config.provider ?? DEFAULT_PROVIDER;
    const model = tenant.config.model ?? DEFAULT_MODEL;
    const aiKey = resolveAiApiKey(provider, tenant.config.aiKeyRef);

    const questions = readFileSync(FILE!, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
    const lines: string[] = [`# Sondeo — ${config.businessName} (${model})`, ''];
    for (const [i, q] of questions.entries()) {
      shared.ghl = new FakeGhl({ timezone: config.timezone, hours: config.hours }) as unknown as Record<string, unknown>;
      const requestContext = buildAgentRequestContext({
        tenant,
        turn: { ghlConversationId: `probe_${i}`, ghlContactId: `probe_contact_${i}`, channel: 'instagram', hasHumanReplies: false },
        provider,
        model,
        llmApiKey: aiKey.apiKey,
      });
      const res = await buildFrontDeskAgent().generate([{ role: 'user', content: q }], { requestContext });
      const tools = (res.toolCalls ?? []).map((c: { payload: { toolName: string } }) => c.payload.toolName);
      lines.push(`## ${i + 1}. ${q}`, '', res.text.trim(), '', tools.length ? `_tools: ${tools.join(', ')}_` : '_tools: ninguno_', '');
      console.log(`\n--- ${i + 1}. ${q}\n${res.text.trim()}\n[${tools.join(', ') || 'sin tools'}]`);
    }
    writeFileSync(`${FILE}.out.md`, lines.join('\n'));
  });
});
