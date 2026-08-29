/**
 * Battery of showcase conversations — the types.
 *
 * A scenario is a LEAD, not a rule: a persona that opens the chat with a fixed message and
 * then improvises (an LLM plays the lead) until its goal is met, it runs out of things to
 * say, or `maxTurns` is hit. The bot side is the real front-desk agent on the tenant's
 * live config, with GHL faked (nothing is ever booked on a real calendar). The output is a
 * transcript JSON that `scripts/render-battery.mjs` turns into WhatsApp-style screenshots.
 *
 * Unlike the evals next door this asserts nothing — its product is the conversation.
 */

import type { Channel, TenantContext } from '../core/types.js';

export interface ScenarioLead {
  /** How the lead introduces themself when asked (the bot asks the name at booking). */
  name: string;
  /** E.164; a WhatsApp lead has one, an IG/FB lead doesn't (leave undefined for those). */
  phone?: string;
  channel?: Channel;
  /**
   * Who this person is and what they want, written to the model that plays them. Say what
   * they know, what they'll accept, and when they're done — the simulator stops on its own
   * when the persona has nothing left to say.
   */
  persona: string;
}

export interface Scenario {
  /** File-safe id: `lead-bueno-botox`. */
  id: string;
  title: string;
  /** What this conversation is meant to show the client (goes in the gallery, not the PNG). */
  shows: string;
  lead: ScenarioLead;
  /** The lead's first message — fixed, so every run opens the same way. */
  opener: string;
  /** Fixed lead messages used in order AFTER the opener, before the persona improvises. */
  script?: string[];
  /** Cap on lead messages (opener included). */
  maxTurns: number;
  /** The goal: once the bot calls any of these tools, the lead gets `closingTurns` more. */
  endWhen?: { toolCalled?: string[] };
  /** Lead messages allowed after `endWhen` fired (a "gracias"), default 1. */
  closingTurns?: number;
  /** An appointment that already exists when the chat starts (for "quiero moverla"). */
  preset?: {
    appointment?: { serviceName: string; daysAhead: number; time: string };
  };
}

export interface TenantScenarios {
  /** The slug used on the command line and as the output folder. */
  slug: string;
  /** Resolves the live config from Supabase when the env is present. */
  ghlLocationId: string;
  /** Offline fallback (the eval fixture) when there is no Supabase env. */
  fixture: TenantContext;
  /** The persona's first name as the prompt introduces it ("Soy Sofía…") — the report's title. */
  assistantName: string;
  scenarios: Scenario[];
}

export interface TranscriptMessage {
  from: 'lead' | 'bot';
  text: string;
  /** Synthetic send time (ISO). The bot's bubbles of one turn are a few seconds apart. */
  at: string;
  /** Bot only: 1-based agent turn this bubble belongs to. */
  turn?: number;
}

export interface TranscriptToolCall {
  turn: number;
  name: string;
  args: unknown;
}

export interface Transcript {
  tenant: { slug: string; businessName: string; assistantName: string; timezone: string; configSource: 'supabase' | 'fixture' };
  scenario: Pick<Scenario, 'id' | 'title' | 'shows'> & { order: number; lead: Pick<ScenarioLead, 'name' | 'channel'> };
  model: string;
  leadModel: string;
  generatedAt: string;
  messages: TranscriptMessage[];
  toolCalls: TranscriptToolCall[];
  /** What the fake GHL ended up with — booked/moved/cancelled appointments, tags, name. */
  ghl: { appointments: FakeAppointment[]; tags: string[]; contactName?: string };
  endedBy: 'fin' | 'maxTurns' | 'goal';
}

export interface FakeAppointment {
  id: string;
  calendarId: string;
  serviceName?: string;
  startTime: string;
  status: 'confirmed' | 'cancelled';
}
