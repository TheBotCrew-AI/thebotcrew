/**
 * Meta Conversions API — pure config/payload helpers (no I/O, no db imports).
 *
 * Why this exists: engagement click-to-WhatsApp ads optimize toward "anyone who
 * messages" unless Meta hears which conversations became real leads. These
 * helpers turn a tenant's `meta_capi` jsonb + a conversation's captured
 * `ctwa_clid` into the exact Graph API event shape Meta's business-messaging
 * CAPI requires. The side-effectful half (enqueue/send) lives in `capi.ts`;
 * this file stays importable from `db/queries.ts` without a cycle.
 */

import type { Channel, ConversationMessage } from '../core/types.js';

export const CAPI_GRAPH_VERSION = 'v23.0';

/** Event names Meta accepts for business-messaging (action_source=business_messaging). */
export const META_BUSINESS_MESSAGING_EVENTS = [
  'Purchase',
  'LeadSubmitted',
  'InitiateCheckout',
  'AddToCart',
  'ViewContent',
  'OrderCreated',
  'OrderShipped',
  'OrderDelivered',
  'OrderCanceled',
  'OrderReturned',
  'CartAbandoned',
  'QualifiedLead',
  'RatingProvided',
  'ReviewProvided',
] as const;
export type MetaEventName = (typeof META_BUSINESS_MESSAGING_EVENTS)[number];

/**
 * Internal lifecycle moments that may become a Meta event. Deliberately NOT
 * per-tenant: the moments are the product's; only their Meta mapping is config.
 * `lead_disqualified` is intentionally absent — Meta has no negative event, the
 * ABSENCE of a QualifiedLead is the signal (see docs/business-logic.md).
 */
export type CapiEventKind = 'lead_started' | 'appointment_booked' | 'conversation_completed';

/** Meta's `messaging_channel` values. Our `facebook` channel is Meta's `messenger`. */
export type CapiMessagingChannel = 'whatsapp' | 'messenger' | 'instagram';

/**
 * The one key Meta matches a business-messaging event on, per channel:
 * WhatsApp → the ad click id (`ctwa_clid`, only CTWA-ad leads have one);
 * Messenger → the page-scoped user id (PSID, every Messenger contact has one);
 * Instagram → the Instagram-scoped id (IGSID, every IG contact has one).
 */
export interface CapiIdentity {
  channel: CapiMessagingChannel;
  key: string;
}

export function capiChannelFor(channel: Channel): CapiMessagingChannel {
  return channel === 'facebook' ? 'messenger' : channel;
}

/** How one internal kind maps to Meta: the event name + optional monetary value. */
export interface CapiEventSpec {
  name: MetaEventName;
  value?: number;
  currency?: string;
}

/**
 * `tenant_config.meta_capi` after validation. `events` overrides the defaults
 * per kind; `false` disables a kind entirely.
 */
export interface MetaCapiConfig {
  /** Default dataset. Meta binds one dataset PER ASSET (Page / WABA / IG account) and
   *  refuses an event sent to a dataset the channel's asset isn't linked to, so a tenant
   *  whose assets landed in different datasets overrides per channel in `datasets`. */
  datasetId: string;
  datasets?: Partial<Record<CapiMessagingChannel, string>>;
  pageId: string;
  /** Slug of the Worker secret with this tenant's CAPI token
   *  (`'MADI'` → `META_CAPI_TOKEN__MADI`). Never the token itself. */
  tokenRef: string;
  /** Events Manager Test Events code — set only while verifying, then remove. Test codes
   *  are per DATASET, so a tenant with per-channel datasets sets `test_event_codes`. */
  testEventCode?: string;
  testEventCodes?: Partial<Record<CapiMessagingChannel, string>>;
  /** WhatsApp Business Account id — sent next to ctwa_clid on WhatsApp events when set. */
  whatsappBusinessAccountId?: string;
  /** Instagram business account id — REQUIRED for Instagram events; without it they are skipped. */
  instagramBusinessAccountId?: string;
  /**
   * How many times the lead must have answered us before `lead_started` fires. 0 (default)
   * = the first inbound. On a click-to-message ad the first inbound is the ad's pre-filled
   * greeting, so 0 signals every click; 1 signals only leads who replied to the bot.
   */
  leadRepliesRequired?: number;
  /**
   * Phones whose conversations never produce an event — the operator's own test numbers on
   * a LIVE tenant. Digits only after parsing; matched on the last 10 digits so the Mexican
   * `+52 1 …` / `+52 …` forms of one number both hit. A conversation's `contact_phone` is
   * captured at inbound and survives every reset, unlike the click id we once NULLed by
   * hand (re-captured from the GHL contact on the next first turn).
   */
  excludePhones?: string[];
  events?: Partial<Record<CapiEventKind, CapiEventSpec | false>>;
}

/** Digits only; the last 10 are the comparable part (country code and the MX mobile `1` vary). */
function phoneKey(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  return digits.length > 10 ? digits.slice(-10) : digits;
}

/** Whether a conversation's phone is on the tenant's CAPI exclusion list. Unknown phone → not excluded. */
export function isExcludedPhone(config: MetaCapiConfig, phone: string | null | undefined): boolean {
  if (!config.excludePhones?.length || !phone) return false;
  const key = phoneKey(phone);
  return key.length >= 7 && config.excludePhones.some((p) => phoneKey(p) === key);
}

/**
 * Platform defaults per kind. `lead_started`/`appointment_booked` are on for any
 * tenant that configures meta_capi at all; `conversation_completed` is opt-in
 * (most tenants' conversion IS the booking — sending both would double-signal).
 * Booking defaults to QualifiedLead, not Purchase: for service SMBs a booking is
 * a qualified lead, and QualifiedLead is what Meta's CTWA lead filtering trains
 * on. A tenant that wants purchase optimization overrides it with a value.
 */
const DEFAULT_EVENT_SPECS: Record<CapiEventKind, CapiEventSpec | false> = {
  lead_started: { name: 'LeadSubmitted' },
  appointment_booked: { name: 'QualifiedLead' },
  conversation_completed: false,
};

function isMetaEventName(v: unknown): v is MetaEventName {
  return typeof v === 'string' && (META_BUSINESS_MESSAGING_EVENTS as readonly string[]).includes(v);
}

function parseEventSpec(raw: unknown): CapiEventSpec | false | null {
  if (raw === false) return false;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const { name, value, currency } = raw as { name?: unknown; value?: unknown; currency?: unknown };
  if (!isMetaEventName(name)) return null;
  const spec: CapiEventSpec = { name };
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) spec.value = value;
  if (typeof currency === 'string' && currency.trim().length === 3) spec.currency = currency.trim().toUpperCase();
  return spec;
}

const CAPI_EVENT_KINDS: CapiEventKind[] = ['lead_started', 'appointment_booked', 'conversation_completed'];

/**
 * Validate the stored meta_capi jsonb; anything malformed → null (feature off),
 * loudly. Same contract as parseQuietHours: a broken config must degrade to
 * "off", never to a half-configured integration sending garbage to Meta.
 */
export function parseMetaCapi(raw: unknown): MetaCapiConfig | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const datasetId = typeof o.dataset_id === 'string' ? o.dataset_id.trim() : '';
  const pageId = typeof o.page_id === 'string' ? o.page_id.trim() : '';
  const tokenRef = typeof o.token_ref === 'string' ? o.token_ref.trim() : '';
  if (!datasetId || !pageId || !tokenRef) {
    console.error('[capi] meta_capi config invalid (needs dataset_id, page_id, token_ref) — feature off');
    return null;
  }
  const config: MetaCapiConfig = { datasetId, pageId, tokenRef };
  if (typeof o.test_event_code === 'string' && o.test_event_code.trim()) {
    config.testEventCode = o.test_event_code.trim();
  }
  const datasets = parsePerChannel(o.datasets);
  if (datasets) config.datasets = datasets;
  const testEventCodes = parsePerChannel(o.test_event_codes);
  if (testEventCodes) config.testEventCodes = testEventCodes;
  if (typeof o.whatsapp_business_account_id === 'string' && o.whatsapp_business_account_id.trim()) {
    config.whatsappBusinessAccountId = o.whatsapp_business_account_id.trim();
  }
  if (typeof o.instagram_business_account_id === 'string' && o.instagram_business_account_id.trim()) {
    config.instagramBusinessAccountId = o.instagram_business_account_id.trim();
  }
  if (o.lead_replies_required !== undefined) {
    const n = o.lead_replies_required;
    if (typeof n === 'number' && Number.isInteger(n) && n >= 0) {
      if (n > 0) config.leadRepliesRequired = n;
    } else {
      console.error('[capi] meta_capi.lead_replies_required must be a non-negative integer — ignoring');
    }
  }
  if (o.exclude_phones !== undefined) {
    if (Array.isArray(o.exclude_phones) && o.exclude_phones.every((p) => typeof p === 'string')) {
      const phones = (o.exclude_phones as string[]).map((p) => p.replace(/\D/g, '')).filter((p) => p.length >= 7);
      if (phones.length) config.excludePhones = phones;
    } else {
      console.error('[capi] meta_capi.exclude_phones must be an array of strings — ignoring');
    }
  }
  if (o.events && typeof o.events === 'object' && !Array.isArray(o.events)) {
    const events: MetaCapiConfig['events'] = {};
    for (const kind of CAPI_EVENT_KINDS) {
      const rawSpec = (o.events as Record<string, unknown>)[kind];
      if (rawSpec === undefined) continue;
      const spec = parseEventSpec(rawSpec);
      if (spec === null) {
        console.error(`[capi] meta_capi.events.${kind} invalid — ignoring that override`);
        continue;
      }
      events[kind] = spec;
    }
    if (Object.keys(events).length > 0) config.events = events;
  }
  return config;
}

/**
 * Worker-secret name for a tenant's CAPI token: `META_CAPI_TOKEN__MADI`.
 * Same slug normalization as aiKeySecretName (core/env.ts): the DB stores only
 * the slug, the token stays in Cloudflare's secret store.
 */
export function capiTokenSecretName(tokenRef: string): string | null {
  const slug = tokenRef
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!slug) return null;
  return `META_CAPI_TOKEN__${slug}`;
}

/**
 * Resolve the tenant's CAPI token from Worker secrets. Unlike resolveAiApiKey
 * there is deliberately NO platform fallback — a Meta token belongs to one
 * advertiser, so falling back would send tenant A's conversions to tenant B's
 * dataset. null = missing; the queue keeps the rows pending (loud, self-heals
 * once the secret lands).
 */
export function resolveCapiToken(tokenRef: string): string | null {
  const secretName = capiTokenSecretName(tokenRef);
  const token = secretName ? process.env[secretName] : undefined;
  return token?.trim() ? token : null;
}

/** `{whatsapp?, messenger?, instagram?}` of non-blank strings; null when nothing usable. */
function parsePerChannel(raw: unknown): Partial<Record<CapiMessagingChannel, string>> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out: Partial<Record<CapiMessagingChannel, string>> = {};
  for (const ch of ['whatsapp', 'messenger', 'instagram'] as const) {
    const v = (raw as Record<string, unknown>)[ch];
    if (typeof v === 'string' && v.trim()) out[ch] = v.trim();
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** The dataset an event on this channel must be posted to: per-channel override > default. */
export function resolveCapiDatasetId(config: MetaCapiConfig, channel: CapiMessagingChannel): string {
  return config.datasets?.[channel] ?? config.datasetId;
}

/** The test code for this channel's dataset: per-channel override > the single code > none. */
export function resolveCapiTestEventCode(config: MetaCapiConfig, channel: CapiMessagingChannel): string | undefined {
  return config.testEventCodes?.[channel] ?? config.testEventCode;
}

/** The effective Meta mapping for a kind: config override > platform default. null = kind off. */
export function resolveEventSpec(config: MetaCapiConfig, kind: CapiEventKind): CapiEventSpec | null {
  const spec = config.events?.[kind] ?? DEFAULT_EVENT_SPECS[kind];
  return spec === false ? null : spec;
}

/**
 * A lead "reply" is an inbound that follows at least one message of ours (bot or human).
 * The ad's pre-filled greeting is the lead's first inbound with nothing of ours before it,
 * so it never counts; an Instant-Form lead answering our opener counts from message one.
 * Returns the count before this turn and including it: the debounce coalesces the lead's
 * trailing messages into ONE turn, so "this turn" is the run of lead messages at the tail.
 */
export function countLeadReplies(history: ConversationMessage[]): { before: number; total: number } {
  let weHaveSpoken = false;
  let total = 0;
  let trailing = 0;
  for (const m of history) {
    if (m.senderType === 'lead') {
      if (weHaveSpoken) {
        total += 1;
        trailing += 1;
      }
    } else {
      weHaveSpoken = true;
      trailing = 0;
    }
  }
  return { before: total - trailing, total };
}

/**
 * Whether THIS turn is the one where the lead crossed `leadRepliesRequired` replies —
 * fires exactly once per conversation (the enqueue is idempotent anyway, so a re-crossing
 * after a clean-start history truncation costs a no-op insert, never a duplicate event).
 * With no threshold configured the first-inbound path in the handler fires instead.
 */
export function leadStartedDue(config: MetaCapiConfig, history: ConversationMessage[]): boolean {
  const required = config.leadRepliesRequired ?? 0;
  if (required === 0) return false;
  const { before, total } = countLeadReplies(history);
  return before < required && total >= required;
}

/** One event per conversation per kind — the queue's UNIQUE key and Meta's dedup event_id. */
export function buildCapiEventId(ghlConversationId: string, kind: CapiEventKind): string {
  return `${ghlConversationId}:${kind}`;
}

/**
 * Pull the click id out of a GHL attribution object. Verified live shape (2026-08-01):
 * `{ sessionSource: 'Paid Social', ctwaClid: 'Afj…', adId, adName, … }` — but GHL's
 * field naming is not a contract, so tolerate snake_case too.
 */
export function extractCtwaClid(attribution: unknown): string | null {
  return firstString(attribution, ['ctwaClid', 'ctwa_clid']);
}

function firstString(obj: unknown, keys: string[]): string | null {
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;
  for (const k of keys) {
    const v = o[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

/**
 * The channel's matching key out of a GHL attribution object. Verified live shapes
 * (2026-08-26, The Bot Crew contacts): a Facebook lead carries
 * `{ sessionSource: 'Paid Social', medium: 'facebook', pSid: '3625…034', adId, … }`, an
 * Instagram one `{ sessionSource: 'Social media', medium: 'instagram', igSid: '1383…020' }`
 * (organic — adId null — still has the id). Keys are looked up per OUR channel, not by
 * whatever the object claims: a WhatsApp conversation never matches on a PSID.
 */
export function extractCapiIdentity(channel: Channel, attribution: unknown): CapiIdentity | null {
  const capiChannel = capiChannelFor(channel);
  const key =
    capiChannel === 'whatsapp'
      ? extractCtwaClid(attribution)
      : capiChannel === 'messenger'
        ? firstString(attribution, ['pSid', 'psid', 'page_scoped_user_id', 'pageScopedUserId'])
        : firstString(attribution, ['igSid', 'ig_sid', 'igsid']);
  return key ? { channel: capiChannel, key } : null;
}

/** E.164 digits only (Meta's `ph` format pre-hash: country code + number, no '+'). */
export function normalizePhoneForCapi(phone: string): string | null {
  const digits = phone.replace(/\D/g, '');
  return digits.length >= 8 ? digits : null;
}

/** Lowercase hex SHA-256 (WebCrypto — available on Workers and in vitest's Node). */
export async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** The frozen event snapshot stored on the queue row (the drain adds name/time/id). */
export interface CapiPayload {
  messaging_channel: CapiMessagingChannel;
  user_data: Record<string, unknown>;
  custom_data?: Record<string, unknown>;
}

/**
 * Build the frozen payload snapshot stored on the queue row: Meta's
 * `messaging_channel` + exactly its `user_data` for that channel (+ optional
 * `custom_data`). Meta's own identifiers (`ctwa_clid`, PSID, IGSID) must NOT be
 * hashed; the phone MUST be SHA-256 hashed. Per channel:
 *   whatsapp  → ctwa_clid + whatsapp_business_account_id. NOT page_id: a WABA dataset has
 *               no Page, and page_id makes Meta run the page↔dataset check and reject
 *               (2804131, seen live 2026-08-27). page_id is the legacy fallback only for a
 *               tenant that hasn't configured the WABA id yet.
 *   messenger → page_scoped_user_id + page_id
 *   instagram → ig_sid + ig_account_id — null (skip) when the tenant hasn't
 *               configured that id: Meta can't match without it. The wire name is
 *               `ig_account_id` (Meta's 2804079 rejection names it), not the
 *               `instagram_business_account_id` their onboarding example shows.
 */
export async function buildCapiPayload(args: {
  config: MetaCapiConfig;
  spec: CapiEventSpec;
  identity: CapiIdentity;
  phone?: string | null;
}): Promise<CapiPayload | null> {
  const { config, identity } = args;
  let user_data: Record<string, unknown>;
  if (identity.channel === 'whatsapp') {
    user_data = config.whatsappBusinessAccountId
      ? { ctwa_clid: identity.key, whatsapp_business_account_id: config.whatsappBusinessAccountId }
      : { ctwa_clid: identity.key, page_id: config.pageId };
  } else if (identity.channel === 'messenger') {
    user_data = { page_scoped_user_id: identity.key, page_id: config.pageId };
  } else {
    if (!config.instagramBusinessAccountId) return null;
    user_data = { ig_sid: identity.key, ig_account_id: config.instagramBusinessAccountId };
  }
  if (args.phone) {
    const normalized = normalizePhoneForCapi(args.phone);
    if (normalized) user_data.ph = [await sha256Hex(normalized)];
  }
  const payload: CapiPayload = { messaging_channel: identity.channel, user_data };
  if (args.spec.value != null) {
    payload.custom_data = { value: args.spec.value, currency: args.spec.currency ?? 'MXN' };
  }
  return payload;
}
