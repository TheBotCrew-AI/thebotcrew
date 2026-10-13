/**
 * The lead's stage (0067): how far the conversation got, read from the thread.
 *
 *   NI  only the ad's pre-filled opener; the lead never answered the bot
 *   I   the bot gave the offer/price; the lead stopped there
 *   A   the lead asked their own questions (we know what they care about)
 *   C   the lead REACTED to slots (wrote after seeing them) or said they want it
 *
 * Two halves. `stageFloor` is deterministic — counts and markers on the thread,
 * no model — and is what the playbook will trust. `raiseStage` lets the status
 * classifier push the stage UP (never down) for the one signal that has no event:
 * "sí me interesa" with no slots offered. The DB keeps the same rule across turns
 * (app_set_conversation_stage only rises), so a shorter history window on a later
 * turn can't demote a lead.
 */

import { messageMatchesTrigger } from './tenant.js';
import type { ConversationMessage } from './types.js';
import { mentionsPrice } from './price-mention.js';
import { LEAD_STAGES, STAGE_RANK as RANK, type LeadStage } from './lead-stage.js';

export { LEAD_STAGES, type LeadStage } from './lead-stage.js';

export interface StageSignals {
  /** The thread so far, in order, INCLUDING the inbound just answered. */
  history: ConversationMessage[];
  /** The bot's reply this turn (not yet in history when the stage is computed). */
  reply: string;
  /** Keywords an ad CTA pre-fills ("PRECIO", "quiero información"): trigger + variant keywords. */
  openerKeywords: string[];
  /** getAvailability ran on this conversation (this turn or any earlier one). */
  slotsOffered: boolean;
  /**
   * Slots were offered BEFORE this turn's inbound — i.e. the lead wrote again after
   * seeing them. Slots the bot shows in this very reply say nothing about the lead yet
   * (the price→slots rule offers them on the first real answer): that lead is I, not C.
   */
  slotsBeforeInbound: boolean;
  /** lookupFaq ran this turn (a classified interest does NOT count: it comes from the opener). */
  askedSomething: boolean;
}

export interface StageFloor {
  stage: LeadStage;
  /** The signals that fired, for the `stage_changed` event. */
  reasons: string[];
}


/** The ad opener, or a one-tap message: ≤4 words with no question mark. */
export function isAdOpener(text: string, openerKeywords: string[]): boolean {
  const t = text.trim();
  if (!t) return true;
  if (openerKeywords.length && messageMatchesTrigger(t, openerKeywords)) return true;
  return !t.includes('?') && t.split(/\s+/).length <= 4;
}

export function stageFloor(s: StageSignals): StageFloor {
  const reasons: string[] = [];
  const lead = s.history.filter((m) => m.senderType === 'lead').map((m) => m.content);
  const bot = s.history.filter((m) => m.senderType === 'bot').map((m) => m.content).concat(s.reply);

  // Engagement = the lead wrote something beyond the opener the ad typed for them.
  const openerIsPrefill = lead.length > 0 && isAdOpener(lead[0]!, s.openerKeywords);
  const ownMessages = lead.length - (openerIsPrefill ? 1 : 0);
  const engaged = ownMessages >= 1;
  if (engaged) reasons.push(`lead_messages:${ownMessages}`);

  const priceGiven = bot.some(mentionsPrice);
  if (priceGiven) reasons.push('price_given');

  const leadAsked = s.askedSomething || lead.some((t, i) => t.includes('?') && (i > 0 || !openerIsPrefill));
  if (leadAsked) reasons.push('lead_asked');
  if (s.slotsOffered) reasons.push('slots_offered');
  if (s.slotsBeforeInbound) reasons.push('lead_wrote_after_slots');

  // C needs the lead's reaction to the slots, not just the bot showing them: on
  // 2026-10-12 "Hola, me interesa el Botox" → "Las tres" → price + slots landed as C
  // although the lead never saw a time. Engagement + slots shown this turn stays below.
  if (engaged && s.slotsBeforeInbound) return { stage: 'C', reasons };
  if (engaged && leadAsked) return { stage: 'A', reasons };
  if (engaged || priceGiven) return { stage: 'I', reasons };
  return { stage: 'NI', reasons };
}

/** The classifier's word can only raise the floor. Anything unparseable is ignored. */
export function raiseStage(floor: LeadStage, raw: unknown): LeadStage {
  const s = typeof raw === 'string' ? raw.trim().toUpperCase() : '';
  if (!(LEAD_STAGES as readonly string[]).includes(s)) return floor;
  return RANK[s as LeadStage] > RANK[floor] ? (s as LeadStage) : floor;
}

/** Addendum to the status classifier's prompt: the stage field it must add. */
export function stagePromptAddendum(): string {
  return `

Además, indica la ETAPA del lead según lo que ÉL escribió (no lo que respondió el bot):
- NI: sólo mandó el mensaje del anuncio, no ha conversado.
- I: ya recibió la información básica (precio/oferta) y nada más.
- A: hizo preguntas propias o contó su caso.
- C: pidió horarios, dijo que sí quiere, o se comprometió a agendar.
Agrega el campo "stage" al JSON: {"status":"active","stage":"A"}.`;
}
