/**
 * Shared, role-agnostic types for the agent runtime.
 *
 * Two DB layers back these: the per-tenant CONFIG (read) layer
 * (`tenants` + `tenant_config`) and the conversation/stats WRITE layer
 * (`conversations`, `messages`, `appointments`, `bot_events`).
 */

export type Direction = 'inbound' | 'outbound';
export type SenderType = 'lead' | 'bot' | 'human_agent';
export type Channel = 'whatsapp' | 'instagram' | 'facebook';
export type AiProvider = 'openai' | 'anthropic';
/** `active` is the only value that permits follow-ups (see app_schedule_follow_up).
 *  `handed_off` is the only one that mutes the bot. `awaiting_human` does neither:
 *  the bot keeps answering, but nudges stay off and a lead reply won't re-arm them. */
export type ConversationStatus =
  | 'active' | 'handed_off' | 'completed' | 'opted_out' | 'standby' | 'awaiting_human';

/**
 * Which ladder a follow-up belongs to (`follow_ups.kind`, migration 0042).
 * `cadence` is the reactivation ladder driven by follow_up_cadence + the angle
 * pool; `demo` is the fixed 3-rung, LLM-free reminder that a demo session is
 * still open. They never mix: a conversation runs one or the other depending on
 * whether it is currently in the demo persona.
 */
export type FollowUpKind = 'cadence' | 'demo';

/**
 * `messages.agent_role` for a demo reminder. It exists to be EXCLUDED: the demo
 * budget meter counts bot messages since the session started
 * (`countBotMessagesSince`), and with only 7 messages to spend, letting three
 * reminders eat into that would cost the lead almost half the demo they came for.
 */
export const DEMO_REMINDER_ROLE = 'demo-reminder';

/** Minutes after the last bot reply for demo reminders 1, 2 and 3. Spread across
 *  the session's 48h life (DEMO_EXPIRES_MINUTES): 30 min, 4 h, 24 h. Platform-wide
 *  — this is the demo feature's own behaviour, not a per-tenant variable. */
export const DEMO_REMINDER_CADENCE = [30, 240, 1440] as const;

/** Quiet (DND) window in tenant-local hours; follow-ups never fire inside it. */
export interface QuietHours {
  /** Local hour [0-23] when the quiet window starts (inclusive). */
  start: number;
  /** Local hour [0-23] when the quiet window ends (exclusive). */
  end: number;
}

/**
 * Raw per-tenant config as stored in `tenant_config` (jsonb fields arrive parsed).
 * Each role validates the slice it needs against its own zod schema.
 */
export interface RawTenantConfig {
  businessName: string;
  timezone: string;
  tone: string | null;
  services: unknown;
  hours: unknown;
  calendars: unknown;
  faq: unknown;
  promptOverrides: unknown;
  /** Prompt overrides for the demo persona (same shape as promptOverrides); null = no demo persona. */
  demoPromptOverrides?: unknown;
  /** Named partial override sets keyed by variant key (per-campaign prompts). A
   *  variant merges field-by-field over promptOverrides at prompt-build time. */
  promptVariants?: unknown;
  /** Overrides the platform-default provider (env-driven). */
  provider?: AiProvider | null;
  /** Overrides the platform-default model for this tenant. */
  model?: string | null;
  /** Delays (minutes) per attempt in a follow-up cycle; null/empty = no follow-ups. The
   *  cycle resets on every lead reply; exhausting it unanswered stops (standby). */
  followUpCadence?: number[] | null;
  /** Pool of angle directives for reactivation messages, decoupled from cadence. A
   *  per-conversation cursor advances across cycles so angles never repeat. */
  followUpAngles?: string[] | null;
  /** Cadences (minutes) for reactivation rounds 1+ — each ghost cycle after the
   *  first runs a shorter, softer ladder (0049). null = platform default taper;
   *  [] = round 0 only. Round 0 always runs followUpCadence. */
  followUpRounds?: number[][] | null;
  /** Quiet window for follow-ups; null/absent uses the platform default (21:00–08:00). */
  quietHours?: QuietHours | null;
  /** Max days ahead the bot may look for / offer appointment slots; null = no cap. */
  bookingHorizonDays?: number | null;
  /** Slug of the Worker secret holding this tenant's own provider key
   *  (`'MADI'` → `OPENAI_API_KEY__MADI`). Never the key itself. null = platform key. */
  aiKeyRef?: string | null;
}

/**
 * Everything the runtime knows about a tenant after resolving the GHL location id.
 * `clientId` is the FK into the stats layer; `config` feeds the role's prompt + tools.
 */
export interface TenantContext {
  tenantId: string;
  clientId: string;
  ghlLocationId: string;
  enabledRoles: string[];
  /** Channels the bot may reply on. null = none (installed but silent). */
  enabledChannels: Channel[] | null;
  /** Pre-live test allowlist: when non-empty, reply only to these GHL contact ids. */
  testContactIds: string[] | null;
  /** Entry-gate keywords: when non-empty, the bot only enters a conversation whose
   *  first message contains one of these. null/empty = no gating. */
  triggerKeywords: string[] | null;
  /** Keywords that switch a conversation into the demo persona (any sender). */
  demoOnKeywords: string[] | null;
  /** Keywords that switch a conversation back to the normal front-desk agent. */
  demoOffKeywords: string[] | null;
  /** Campaign keyword → variant key (n:1; several keywords may share a variant).
   *  Matching is first-touch sticky per conversation. null/empty = no variants. */
  keywordVariants: Record<string, string> | null;
  /** Tag written on the GHL contact when the bot leaves a request for a person to pick
   *  up (flagAwaitingHuman). null = this tenant doesn't use that signal. */
  awaitingHumanTag: string | null;
  /** Tag written when the lead asked something that is NOT in the config and the bot
   *  promised to confirm it (flagPendingInfo). Deliberately a SECOND tag: this queue is
   *  ours (the config has a hole), `awaitingHumanTag` is the client's (someone must
   *  book). null = this tenant doesn't use that signal. */
  pendingInfoTag: string | null;
  /** Whether the startDemo tool may create budgeted per-lead demo sessions on this
   *  tenant (the lead-magnet funnel). false = the tool refuses; nothing else changes. */
  demoSessionsEnabled: boolean;
  /** Meta Conversions API config (validated). null = no conversion signals for this
   *  tenant; every CAPI hook no-ops. See meta/capi-config.ts. */
  metaCapi: import('../meta/capi-config.js').MetaCapiConfig | null;
  config: RawTenantConfig;
}

/** Context injected into the turn right after a demo session ended: the normal
 *  persona (the closer) answers knowing what the lead just experienced. */
export interface DemoHandoff {
  reason: 'exhausted' | 'expired' | 'closed' | 'booked';
  businessName?: string;
  businessType?: string;
  /** The person's name, captured during intake — so the closer never re-asks it. */
  leadName?: string;
  /** Services the demo was configured with (what the lead told us about their business). */
  services?: string[];
  /** Whether the lead booked inside the demo — the strongest intent signal available. */
  booked?: boolean;
}

/** Identifiers for the single inbound turn currently being handled. */
export interface TurnContext {
  ghlConversationId: string;
  ghlContactId: string;
  contactPhone?: string;
  /** Name the contact is stored under in GHL. Fetched only during the opening turns so the
   *  agent can confirm/correct it (page-form leads often arrive named after their business). */
  contactName?: string;
  channel: Channel;
  /** Which persona handles this turn: undefined/'front-desk' = normal; 'demo' = demo persona. */
  activeRole?: string;
  /** Campaign prompt variant pinned to this conversation (first-touch sticky);
   *  undefined = base prompt. Ignored while the demo persona is active. */
  promptVariant?: string;
  /** The contact's active (not cancelled, not past) appointment, resolved at turn start.
   *  Present so the agent knows it already booked and never re-offers availability against
   *  its own appointment (the self-block class). Skipped in demo mode (clean-start). */
  activeAppointment?: { startTime: string; service?: string };
  /** Set only on the turn where a demo session just ended — the closer's context. */
  demoHandoff?: DemoHandoff;
}

/** A turn in our own conversation store, used to rebuild agent history. */
export interface ConversationMessage {
  direction: Direction;
  senderType: SenderType;
  content: string;
  agentRole?: string;
  humanAgentId?: string;
  model?: string;
  sentAt: string;
}
