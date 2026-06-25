/**
 * Front-desk eval cases.
 *
 * Offline cases (always run): prompt template + config validation — the
 * deterministic backbone of the anti-hallucination guarantee.
 *
 * Live cases (run only when ANTHROPIC_API_KEY is set): exercise the real agent
 * for qualification, booking intent, and anti-hallucination behavior. They build
 * the request context by hand so no DB is needed.
 *
 * Run: `pnpm --filter @thebotcrew/workers eval`
 */

import { describe, it, expect } from 'vitest';
import { buildFrontDeskInstructions } from '../prompt.js';
import { parseFrontDeskConfig } from '../config.js';
import { buildFrontDeskAgent, DEFAULT_MODEL } from '../agent.js';
import { buildAgentRequestContext } from '../../../core/runtime-context.js';
import type { AiProvider, TurnContext } from '../../../core/types.js';
import { demoTenant } from './fixtures.js';

describe('front-desk prompt (offline)', () => {
  const config = parseFrontDeskConfig(demoTenant.config);
  const prompt = buildFrontDeskInstructions(config, new Date().toISOString());

  it('fills the business name and services from config', () => {
    expect(prompt).toContain('Clínica Demo');
    expect(prompt).toContain('Consulta general');
    expect(prompt).toContain('Limpieza dental');
  });

  it('carries the anti-hallucination rule and the availability→booking sequence', () => {
    expect(prompt).toContain('Nunca inventes');
    expect(prompt).toContain('getAvailability');
    expect(prompt).toContain('agendar');
  });

  it('validates config (services + calendars + faq present)', () => {
    expect(config.services).toHaveLength(2);
    expect(config.calendars['Consulta general']).toBe('cal_demo_general');
    expect(config.faq.length).toBeGreaterThan(0);
  });
});

const turn: TurnContext = {
  ghlConversationId: 'conv_eval',
  ghlContactId: 'contact_eval',
  channel: 'whatsapp',
};

const evalProvider: AiProvider = process.env.ANTHROPIC_API_KEY ? 'anthropic' : 'openai';
const evalApiKey = process.env.ANTHROPIC_API_KEY ?? process.env.OPENAI_API_KEY ?? '';

function evalRequestContext() {
  return buildAgentRequestContext({
    tenant: demoTenant,
    turn,
    provider: evalProvider,
    model: DEFAULT_MODEL,
    llmApiKey: evalApiKey,
  });
}

describe.skipIf(!evalApiKey)('front-desk agent (live)', () => {
  it('responds in Spanish to a qualification opener', async () => {
    const agent = buildFrontDeskAgent();
    const res = await agent.generate('Hola, ¿qué servicios ofrecen?', {
      requestContext: evalRequestContext(),
    });
    expect(res.text.length).toBeGreaterThan(0);
    // crude Spanish smell test: mentions a configured service
    expect(res.text.toLowerCase()).toMatch(/consulta|limpieza/);
  });

  it('does not invent a price that is not in config (anti-hallucination)', async () => {
    const agent = buildFrontDeskAgent();
    const res = await agent.generate('¿Cuánto cuesta exactamente la consulta general?', {
      requestContext: evalRequestContext(),
    });
    // No price is configured → the agent must not fabricate a currency amount.
    expect(res.text).not.toMatch(/\$\s?\d/);
    expect(res.text).not.toMatch(/\d+\s?(pesos|mxn)/i);
  });
});
