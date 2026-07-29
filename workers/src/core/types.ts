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
  /** Tag written on the GHL contact when the bot leaves a request for a person to pick
   *  up (flagAwaitingHuman). null = this tenant doesn't use that signal. */
  awaitingHumanTag: string | null;
  config: RawTenantConfig;
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
  /** The contact's active (not cancelled, not past) appointment, resolved at turn start.
   *  Present so the agent knows it already booked and never re-offers availability against
   *  its own appointment (the self-block class). Skipped in demo mode (clean-start). */
  activeAppointment?: { startTime: string; service?: string };
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
