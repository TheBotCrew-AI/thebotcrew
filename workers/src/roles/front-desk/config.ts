/**
 * Front-desk role config schema.
 *
 * Validates the slice of `tenant_config` this role consumes. The agent only
 * states facts that come from this config or from tool results — so a clean,
 * validated config is the anti-hallucination foundation.
 */

import { z } from 'zod';
import type { RawTenantConfig } from '../../core/types.js';

export const serviceSchema = z.object({
  name: z.string(),
  durationMin: z.number().int().positive().optional(),
  description: z.string().optional(),
  /** Per-service hold amount in pesos (0062); overrides bookingPayment.amount for this service. */
  deposit: z.number().positive().optional(),
});

/**
 * Paid confirmation (0062). Set on a tenant, a bot booking holds the slot as
 * `new` until the lead pays a Stripe Checkout link; the cron releases it after
 * `holdHours`. Amounts are pesos (converted to cents at the Stripe boundary).
 * The money lands on the PLATFORM Stripe account — one account for every
 * tenant, platform-level secrets — because this is how the platform gets paid.
 */
export const bookingPaymentSchema = z.object({
  amount: z.number().positive(),
  currency: z.string().length(3).default('mxn'),
  holdHours: z.number().int().positive().default(24),
  /** How long BEFORE the cita the payment must be in (0063): the deadline is the sooner of
   *  now + holdHours and cita − deadlineMarginHours, so a same-day cita never has a deadline
   *  after the cita itself (2026-09-22: 6:30 a.m. cita, "paga antes de las 6:46 p.m."). */
  deadlineMarginHours: z.number().nonnegative().default(2),
  /** The one pre-deadline reminder (0065): how many hours before the deadline it aims for, moved
   *  out of the quiet window by `payments/hold-reminder.ts`. 0 = no reminder. */
  reminderHoursBefore: z.number().nonnegative().default(3),
  /** What the deposit is, in the tenant's words (rendered into the prompt): "se descuenta del
   *  costo de la consulta", "es una cuota de reservación", … Absent = nothing is claimed. */
  depositNote: z.string().optional(),
  /** Card-statement suffix so the lead recognizes the charge ("THE BOT CREW* DR VALDIVIA").
   *  Stripe caps the suffix at 22 characters; letters/digits/spaces only. */
  statementSuffix: z.string().max(22).regex(/^[A-Za-z0-9 ]*$/).optional(),
  /** Stripe Connect (0064): the tenant's connected account. Set, the charge lands in THEIR
   *  Stripe (their name on the Checkout page and the card statement); absent, in the platform's. */
  stripeAccount: z.string().regex(/^acct_[A-Za-z0-9]+$/).optional(),
  /** With `stripeAccount`: what the platform keeps of each charge, in pesos (application fee). */
  platformFee: z.number().nonnegative().optional(),
});
export type BookingPaymentConfig = z.infer<typeof bookingPaymentSchema>;

/**
 * The stored jsonb is snake_case (like meta_capi); malformed → null + a loud log.
 * Null means the feature is OFF for the tenant: a bad row makes citas free, which
 * is visible in `booking_holds` staying empty, whereas throwing here would kill
 * every turn for the tenant — a silent outage over a typo in a config field.
 */
export function parseBookingPayment(raw: unknown): BookingPaymentConfig | null {
  if (raw == null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    console.error('[booking-payment] tenant_config.booking_payment is not an object — feature off');
    return null;
  }
  const o = raw as Record<string, unknown>;
  const parsed = bookingPaymentSchema.safeParse({
    amount: o.amount,
    currency: typeof o.currency === 'string' ? o.currency.toLowerCase() : undefined,
    holdHours: o.hold_hours ?? o.holdHours,
    deadlineMarginHours: o.deadline_margin_hours ?? o.deadlineMarginHours,
    reminderHoursBefore: o.reminder_hours_before ?? o.reminderHoursBefore,
    depositNote: o.deposit_note ?? o.depositNote,
    statementSuffix: o.statement_suffix ?? o.statementSuffix,
    stripeAccount: o.stripe_account ?? o.stripeAccount,
    platformFee: o.platform_fee ?? o.platformFee,
  });
  if (!parsed.success) {
    console.error('[booking-payment] tenant_config.booking_payment invalid — feature off:', parsed.error.message);
    return null;
  }
  return parsed.data;
}

export const dayHoursSchema = z.array(
  z.object({ open: z.string(), close: z.string() }),
);

/** Weekly schedule keyed by weekday (mon, tue, …). */
export const hoursSchema = z.record(z.string(), dayHoursSchema);

export const faqSchema = z.array(z.object({ q: z.string(), a: z.string() }));

export const promptOverridesSchema = z.object({
  /** Replaces the opening identity line. Use to disclose AI nature, role, and channels. */
  identity: z.string().optional(),
  /** Replaces the services section. Use for rich offering/pricing descriptions. */
  offering: z.string().optional(),
  /** Appended after the built-in qualification flow. Use for tenant-specific instructions. */
  qualificationNotes: z.string().optional(),
  /**
   * Tenant-wide rules that outrank the conversational flow — who we will and won't
   * serve, what we never promise. Rendered from BASE config even when a campaign
   * variant is pinned, which is the whole point: a variant replaces a whole field,
   * so a rule written inside `qualificationNotes` silently vanishes the day a
   * campaign overrides that field (no event, no failure — it just stops happening).
   * Deliberately absent from `promptVariantSchema` so a variant cannot set it.
   *
   * Suppressed in demo mode: house rules describe the REAL business, and inside a
   * roleplay for someone else's business they are incoherent.
   */
  houseRules: z.string().optional(),
  /**
   * Per-tool business rules, keyed by tool id (e.g. "getAvailability").
   * Injected as a dedicated prompt section so the agent knows how to interpret
   * and present each tool's results for this specific tenant.
   */
  toolInstructions: z.record(z.string(), z.string()).default({}),
  /**
   * When true, a deterministic post-turn backstop corrects the GHL contact name during the
   * opening exchanges (page-form leads often arrive named after their business). The prompt
   * also asks the agent to confirm the name, but the backstop is what guarantees the write —
   * OpenAI models routinely skip the side-effect-only updateContactName tool.
   */
  confirmContactName: z.boolean().default(false),
  /**
   * Whether this tenant books through the bot at all. Default true = current behavior.
   *
   * Set false for tenants with no calendar the bot can trust — e.g. MADI, who rents a
   * shared laser booth on a third party's calendar. It strips every booking instruction
   * from the prompt (the availability sequence, the strict-availability rules, the
   * reschedule/cancel rules) instead of leaving them to contradict a tenant override that
   * says "don't book". Those sections are emphatic ("Cuando el lead pida cita, llama
   * getAvailability") and render AFTER the tenant's own notes, so config alone can't
   * reliably override them — which is how a bot ends up promising a slot it can't hold.
   */
  bookingEnabled: z.boolean().default(true),
});

/**
 * A campaign prompt variant: a PARTIAL override set merged field-by-field over
 * the base promptOverrides at prompt-build time. Deliberately has NO defaults —
 * a zod default here would materialize on parse and clobber the base value in
 * the merge. Only prompt-affecting fields are overridable; behavior toggles that
 * live outside the prompt (confirmContactName) stay base-level on purpose, so a
 * variant can never half-enable a backstop the handler reads from base config.
 */
export const promptVariantSchema = z.object({
  identity: z.string().optional(),
  offering: z.string().optional(),
  qualificationNotes: z.string().optional(),
  /** Merged PER-KEY over the base toolInstructions (base rules survive unless overridden). */
  toolInstructions: z.record(z.string(), z.string()).optional(),
  bookingEnabled: z.boolean().optional(),
  /**
   * Campaign-specific reactivation angles. When present and non-empty, follow-ups
   * for conversations pinned to this variant draw from THIS pool instead of the
   * tenant's follow_up_angles (replace, not merge — sent-angle indexes are
   * positions within one pool). See roles/reactivation/angle-select.ts.
   */
  followUpAngles: z.array(z.string()).optional(),
  /**
   * Whether conversations pinned to this variant may be nudged. Absent = the
   * tenant's cadence applies as always; `false` opts the campaign out of BOTH
   * ladders (the arming in webhook-handler and, defensively, the runner). It is
   * not a prompt field — see core/reactivation-rounds.ts `variantAllowsFollowUps`.
   */
  followUpsEnabled: z.boolean().optional(),
  /**
   * Campaign tag appended to the GHL calendar event title when a conversation
   * pinned to this variant books (e.g. "Jornada Bótox" → "Karla — Bótox — Jornada
   * Bótox"), so staff see which promo brought the lead. Variant metadata read
   * directly by bookAppointment (tools/appointment-title.ts) — NOT a prompt field;
   * the merge in resolveEffectiveOverrides copies it harmlessly but nothing renders it.
   */
  calendarLabel: z.string().optional(),
});

export const frontDeskConfigSchema = z.object({
  businessName: z.string().min(1),
  timezone: z.string().min(1),
  tone: z.string().nullable().optional(),
  services: z.array(serviceSchema).default([]),
  hours: hoursSchema.default({}),
  /** Map of service name -> GHL calendar id. */
  calendars: z.record(z.string(), z.string()).default({}),
  faq: faqSchema.default([]),
  promptOverrides: promptOverridesSchema.default({ toolInstructions: {}, confirmContactName: false, bookingEnabled: true }),
  /** Persona overrides used when the conversation is in demo mode (active_role='demo'). null = none. */
  demoPromptOverrides: promptOverridesSchema.nullable().default(null),
  /** Named campaign variants keyed by variant key (see keyword_variants). null = none. */
  promptVariants: z.record(z.string(), promptVariantSchema).nullable().default(null),
  /** Max days ahead the bot may look for / offer slots. null = no cap. Enforced in getAvailability. */
  bookingHorizonDays: z.number().int().positive().nullable().default(null),
  /** Min calendar days of notice: 1 = never today, first slot from local midnight of tomorrow.
   *  null = same-day allowed. Enforced in getAvailability / bookAppointment / rescheduleAppointment. */
  bookingMinNoticeDays: z.number().int().positive().nullable().default(null),
  /** Show times in the lead's zone (remote-service tenants only). See core/lead-timezone.ts. */
  leadTimezoneEnabled: z.boolean().default(false),
  /** Book/reschedule as "No confirmada" so a GHL workflow owns the confirmation (0061). */
  bookUnconfirmed: z.boolean().default(false),
  /** Paid confirmation (0062): null = off. Already validated by parseBookingPayment. */
  bookingPayment: bookingPaymentSchema.nullable().default(null),
});

export type FrontDeskConfig = z.infer<typeof frontDeskConfigSchema>;
export type FrontDeskService = z.infer<typeof serviceSchema>;
export type PromptOverrides = z.infer<typeof promptOverridesSchema>;
export type PromptVariant = z.infer<typeof promptVariantSchema>;

/**
 * Resolve the override set in effect for this turn. Priority:
 *   1. demo persona (activeRole === 'demo' with demoPromptOverrides configured)
 *   2. the conversation's pinned campaign variant, merged over base
 *   3. base promptOverrides
 * A pinned variant whose key is missing from promptVariants falls back to base
 * (the misconfiguration was already logged as variant_assigned{known:false}).
 */
export function resolveEffectiveOverrides(
  config: FrontDeskConfig,
  activeRole?: string,
  promptVariant?: string,
): { overrides: PromptOverrides; usingDemo: boolean } {
  if (activeRole === 'demo' && config.demoPromptOverrides) {
    return { overrides: config.demoPromptOverrides, usingDemo: true };
  }
  const base = config.promptOverrides;
  const variant = promptVariant ? config.promptVariants?.[promptVariant] : undefined;
  if (!variant) return { overrides: base, usingDemo: false };
  return {
    overrides: {
      ...base,
      ...variant,
      // Per-key merge: campaign rules override individual tools, not the whole map.
      toolInstructions: { ...base.toolInstructions, ...(variant.toolInstructions ?? {}) },
      // House rules are the tenant's, not the campaign's. promptVariantSchema has no
      // such field, so the spread above can't touch it today — this line is what keeps
      // that true if someone ever adds one, and makes the guarantee visible here.
      houseRules: base.houseRules,
    },
    usingDemo: false,
  };
}

/** Validate + narrow the raw tenant config into the front-desk shape. */
export function parseFrontDeskConfig(raw: RawTenantConfig): FrontDeskConfig {
  return frontDeskConfigSchema.parse({
    businessName: raw.businessName,
    timezone: raw.timezone,
    tone: raw.tone,
    services: raw.services,
    hours: raw.hours,
    calendars: raw.calendars,
    faq: raw.faq,
    promptOverrides: raw.promptOverrides ?? {},
    demoPromptOverrides: raw.demoPromptOverrides ?? null,
    promptVariants: raw.promptVariants ?? null,
    bookingHorizonDays: raw.bookingHorizonDays ?? null,
    bookingMinNoticeDays: raw.bookingMinNoticeDays ?? null,
    leadTimezoneEnabled: raw.leadTimezoneEnabled === true,
    bookUnconfirmed: raw.bookUnconfirmed === true,
    bookingPayment: parseBookingPayment(raw.bookingPayment),
  });
}

/** Hold amount for a service, in cents: the service's own `deposit` wins over the tenant amount. */
export function holdAmountCents(config: FrontDeskConfig, serviceName: string): number | null {
  const payment = config.bookingPayment;
  if (!payment) return null;
  const perService = config.services.find((s) => s.name === serviceName)?.deposit;
  const pesos = perService ?? payment.amount;
  return Math.round(pesos * 100);
}
