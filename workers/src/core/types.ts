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
export type ConversationStatus = 'active' | 'handed_off' | 'completed' | 'opted_out' | 'standby';

export interface FollowUpTier {
  tier: number;
  delayMinutes: number;
  /** Short prompt describing the angle/hook for the reactivation message. */
  angle: string;
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
  /** Overrides the platform-default provider (env-driven). */
  provider?: AiProvider | null;
  /** Overrides the platform-default model for this tenant. */
  model?: string | null;
  /** Configures follow-up tiers; null/absent means no follow-ups. */
  followUpTiers?: FollowUpTier[] | null;
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
  config: RawTenantConfig;
}

/** Identifiers for the single inbound turn currently being handled. */
export interface TurnContext {
  ghlConversationId: string;
  ghlContactId: string;
  contactPhone?: string;
  channel: Channel;
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
