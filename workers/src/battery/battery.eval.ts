/**
 * Runs a tenant's showcase battery: the real front-desk agent on the tenant's LIVE config,
 * against a faked GHL and a faked DB, with an LLM playing each lead. Writes one transcript
 * per scenario to `workers/battery/<slug>/<id>.json` for `scripts/render-battery.mjs`.
 *
 *   pnpm battery heriberto                     # every scenario
 *   pnpm battery heriberto --only lead-bueno-botox,solo-info-precios
 *
 * It is a vitest file only to borrow `vi.mock` (the same mocking the evals use) — it
 * self-skips unless BATTERY_TENANT is set, so `pnpm eval` never runs it.
 */

import { describe, it, expect, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ModelMessage } from 'ai';

// Keys come from workers/.env; eval-model.ts reads process.env at import, so load first.
await vi.hoisted(async () => {
  const { loadDotEnv } = await import('./dotenv.js');
  loadDotEnv();
});

const shared = vi.hoisted(() => ({ ghl: null as null | Record<string, unknown> }));

vi.mock('../ghl/client.js', () => ({
  GhlClient: vi.fn(() => {
    if (!shared.ghl) throw new Error('battery: FakeGhl not set for this scenario');
    return shared.ghl;
  }),
}));

// Everything but the config read is faked. Unknown queries THROW rather than reach prod:
// a stub that quietly "works" would let a new write land in the real tables.
vi.mock('../db/queries.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../db/queries.js')>();
  const ghl = () => shared.ghl as unknown as import('./fake-ghl.js').FakeGhl;
  const stubs: Record<string, (...args: never[]) => unknown> = {
    logBotEvent: async () => undefined,
    logEvent: async () => ({ eventId: 'evt_fake' }),
    logLlmUsage: async () => undefined,
    getActiveDemoSession: async () => null,
    createDemoSession: async () => ({ sessionId: 'demo_fake' }),
    setSimulatedBooking: async () => undefined,
    setLeadTimezone: async () => undefined,
    updateConversationStatus: async () => true,
    reactivateConversation: async () => undefined,
    resetReactivationRound: async () => undefined,
    cancelFollowUps: async () => undefined,
    scheduleFollowUp: async () => undefined,
    loadAppointmentLog: async () => ghl().appointmentLog,
    logAppointment: async (p: {
      p_action: string;
      p_appointment_datetime: string | null;
      p_service_type: string | null;
      p_ghl_appointment_id: string | null;
    }) => {
      ghl().appointmentLog.unshift({
        ghlAppointmentId: p.p_ghl_appointment_id ?? '',
        action: p.p_action,
        appointmentDatetime: p.p_appointment_datetime,
        serviceType: p.p_service_type,
        createdAt: new Date().toISOString(),
      });
      return { appointmentId: 'appt_row_fake' };
    },
  };
  const out: Record<string, unknown> = {};
  for (const name of Object.keys(real)) {
    out[name] =
      name === 'loadTenantConfig'
        ? real[name as keyof typeof real]
        : stubs[name] ??
          (() => {
            throw new Error(`battery: db query "${name}" is not faked — add a stub before it touches prod`);
          });
  }
  return out;
});

import { loadTenantConfig } from '../db/queries.js';
import { buildFrontDeskAgent } from '../roles/front-desk/agent.js';
import { buildAgentRequestContext } from '../core/runtime-context.js';
import { findUpcomingAppointment } from '../db/upcoming-appointment.js';
import { splitIntoMessages } from '../worker/webhook-handler.js';
import { parseFrontDeskConfig } from '../roles/front-desk/config.js';
import { evalApiKey, evalModel, evalProvider } from '../roles/front-desk/evals/eval-model.js';
import type { TenantContext, TurnContext } from '../core/types.js';
import { FakeGhl } from './fake-ghl.js';
import { makeLeadSimulator } from './lead-simulator.js';
import { TENANT_SCENARIOS } from './scenarios/index.js';
import type { Scenario, Transcript, TranscriptMessage, TranscriptToolCall } from './scenario.js';

const SLUG = process.env.BATTERY_TENANT ?? '';
const ONLY = (process.env.BATTERY_ONLY ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const LEAD_MODEL = process.env.BATTERY_LEAD_MODEL ?? evalModel;
const OUT_DIR = fileURLToPath(new URL(`../../battery/${SLUG}/`, import.meta.url));

const bundle = TENANT_SCENARIOS[SLUG];

type ToolCallChunkLike = { payload: { toolName: string; args?: unknown } };
const toolCallsOf = (res: { toolCalls?: ToolCallChunkLike[] }) =>
  (res.toolCalls ?? []).map((c) => ({ name: c.payload.toolName, args: c.payload.args }));

/** Live config when Supabase env is present (what prod runs), else the eval fixture. */
async function resolveTenant(): Promise<{ tenant: TenantContext; source: Transcript['tenant']['configSource'] }> {
  if (!bundle) throw new Error(`unknown battery tenant "${SLUG}" — known: ${Object.keys(TENANT_SCENARIOS).join(', ')}`);
  if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    const live = await loadTenantConfig(bundle.ghlLocationId);
    if (!live) throw new Error(`tenant ${bundle.ghlLocationId} not found in Supabase`);
    return { tenant: live, source: 'supabase' };
  }
  return { tenant: bundle.fixture, source: 'fixture' };
}

/** Synthetic send times: a lead types for a minute or three, the bot answers within one. */
function makeClock(startMs: number) {
  let t = startMs;
  let i = 0;
  return {
    lead(): string {
      i += 1;
      if (i > 1) t += (60 + ((i * 37) % 120)) * 1000;
      return new Date(t).toISOString();
    },
    bot(bubble: number): string {
      if (bubble === 0) t += (35 + ((i * 13) % 30)) * 1000;
      else t += 4000 + Math.min(6000, 25 * 60);
      return new Date(t).toISOString();
    },
  };
}

async function runScenario(scenario: Scenario, order: number, tenant: TenantContext, source: Transcript['tenant']['configSource']): Promise<Transcript> {
  const config = parseFrontDeskConfig(tenant.config);
  const ghl = new FakeGhl({ timezone: config.timezone, hours: config.hours, phone: scenario.lead.phone });
  shared.ghl = ghl as unknown as Record<string, unknown>;

  if (scenario.preset?.appointment) {
    const { serviceName, daysAhead, time } = scenario.preset.appointment;
    const calendarId = config.calendars[serviceName];
    if (!calendarId) throw new Error(`preset appointment: no calendar for "${serviceName}"`);
    ghl.seedAppointment({ calendarId, serviceName, startTime: ghl.slotAt(daysAhead, time) });
  }

  const turn: TurnContext = {
    ghlConversationId: `conv_battery_${scenario.id}`,
    ghlContactId: `contact_battery_${scenario.id}`,
    contactPhone: scenario.lead.phone,
    channel: scenario.lead.channel ?? 'whatsapp',
    hasHumanReplies: false,
  };
  const requestContext = buildAgentRequestContext({
    tenant,
    turn,
    provider: tenant.config.provider ?? evalProvider,
    model: tenant.config.model ?? evalModel,
    llmApiKey: evalApiKey,
  });
  const agent = buildFrontDeskAgent();
  const lead = makeLeadSimulator({ lead: scenario.lead, provider: evalProvider, model: LEAD_MODEL, apiKey: evalApiKey });

  const history: ModelMessage[] = [];
  const messages: TranscriptMessage[] = [];
  const toolCalls: TranscriptToolCall[] = [];
  const clock = makeClock(Date.now());
  const script = [...(scenario.script ?? [])];
  const goal = new Set(scenario.endWhen?.toolCalled ?? []);
  let closingLeft = scenario.closingTurns ?? 1;
  let goalMet = false;
  let endedBy: Transcript['endedBy'] = 'maxTurns';
  let leadText: string | null = scenario.opener;

  const say = (who: string, text: string) => console.log(`\n--- ${who} ---\n${text}`);

  for (let t = 1; t <= scenario.maxTurns && leadText; t++) {
    history.push({ role: 'user', content: leadText });
    messages.push({ from: 'lead', text: leadText, at: clock.lead() });
    say(`${t}. ${scenario.lead.name.toUpperCase()}`, leadText);

    // Same as runAgentTurn: the agent must know about an appointment it (or a preset) booked.
    const appt = await findUpcomingAppointment(tenant.clientId, turn.ghlContactId, ghl, Date.now());
    turn.activeAppointment = appt ? { startTime: appt.startTime, service: appt.service } : undefined;

    const res = await agent.generate(history, { requestContext, maxSteps: 8 });
    const calls = toolCallsOf(res);
    for (const c of calls) toolCalls.push({ turn: t, ...c });
    const bubbles = splitIntoMessages(res.text);
    bubbles.forEach((b, i) => {
      history.push({ role: 'assistant', content: b });
      messages.push({ from: 'bot', text: b, at: clock.bot(i), turn: t });
    });
    say(`${t}. BOT (${bubbles.length} burbuja/s) tools=${calls.map((c) => c.name).join(',') || 'none'}`, res.text);

    if (!goalMet && calls.some((c) => goal.has(c.name))) {
      goalMet = true;
      endedBy = 'goal';
    } else if (goalMet) {
      closingLeft -= 1;
    }
    if (goalMet && closingLeft <= 0) break;
    if (t === scenario.maxTurns) break;

    leadText = script.shift() ?? (await lead.next(history, { closing: goalMet }));
    if (!leadText && !goalMet) endedBy = 'fin';
  }

  return {
    tenant: { slug: bundle!.slug, businessName: config.businessName, assistantName: bundle!.assistantName, timezone: config.timezone, configSource: source },
    scenario: {
      id: scenario.id,
      order,
      title: scenario.title,
      shows: scenario.shows,
      lead: { name: scenario.lead.name, channel: scenario.lead.channel ?? 'whatsapp' },
    },
    model: tenant.config.model ?? evalModel,
    leadModel: LEAD_MODEL,
    generatedAt: new Date().toISOString(),
    messages,
    toolCalls,
    ghl: {
      appointments: ghl.appointments,
      tags: [...ghl.tags],
      contactName: ghl.contactName ? `${ghl.contactName.firstName} ${ghl.contactName.lastName}`.trim() : undefined,
    },
    endedBy,
  };
}

describe.skipIf(!SLUG || !evalApiKey)(`battery — ${SLUG}`, () => {
  const scenarios = (bundle?.scenarios ?? []).filter((s) => ONLY.length === 0 || ONLY.includes(s.id));
  if (bundle && ONLY.length && scenarios.length === 0) {
    throw new Error(`--only matched nothing; ids: ${bundle.scenarios.map((s) => s.id).join(', ')}`);
  }

  for (const scenario of scenarios) {
    it(scenario.id, async () => {
      const { tenant, source } = await resolveTenant();
      console.log(`\n==== ${scenario.id} — ${scenario.title} (config: ${source}) ====`);
      const transcript = await runScenario(scenario, bundle!.scenarios.indexOf(scenario), tenant, source);
      mkdirSync(OUT_DIR, { recursive: true });
      const file = `${OUT_DIR}${scenario.id}.json`;
      writeFileSync(file, JSON.stringify(transcript, null, 2) + '\n');
      console.log(`\n[battery] ${transcript.messages.length} mensajes, endedBy=${transcript.endedBy} → ${file}`);
      expect(transcript.messages.length).toBeGreaterThan(1);
    }, 15 * 60_000);
  }
});
