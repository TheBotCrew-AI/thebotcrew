/**
 * Info-gap runner (0054): two cron entry points.
 *
 * `runInfoGapExtractions` — every 5 minutes. Opens a run for any tenant that is due
 * (see info-gaps/config.ts), drains a few queued conversations through the
 * extraction prompt, and when a run's queue is empty aggregates its results into
 * `info_gaps` and writes the report. Queue-in-DB rather than a batch API so a run
 * spreads across ticks with no time pressure and no second "collect results" job.
 *
 * `runPendingInfoAlerts` — daily. A `pending_info` question no human answered
 * inside the tenant's window gets the escalation tag on the GHL contact, so it
 * shows up where the team already works. Idempotent through the
 * `pending_info_escalated` event; a failed tag is retried the next day.
 *
 * Nothing here writes tenant_config. The report is for a person to act on.
 */

import type { AiProvider, TenantContext } from '../core/types.js';
import { resolveAiApiKey } from '../core/env.js';
import {
  claimInfoGapExtractions,
  completeInfoGapExtraction,
  countInfoGapCandidates,
  finishInfoGapRun,
  getTenantGhlLocationId,
  loadFinalizableInfoGapRuns,
  loadInfoGapExtractions,
  loadInfoGapTenants,
  loadInfoGaps,
  loadRecentMessages,
  loadTenantConfig,
  loadTenantConfigLastChange,
  loadUnansweredPendingInfo,
  logBotEvent,
  openInfoGapRun,
  saveInfoGapReport,
  upsertInfoGap,
} from '../db/queries.js';
import type { FinalizableInfoGapRun } from '../db/types.js';
import { GhlClient } from '../ghl/client.js';
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from '../roles/front-desk/index.js';
import { auxJsonCompletion, type AuxLlmCall } from './aux-llm.js';
import { toUpserts, type ExtractionRecord } from './info-gaps/aggregate.js';
import { isRunDue, parseInfoGaps } from './info-gaps/config.js';
import { buildExtractionPrompt, parseExtraction, type ExtractionResult, type TranscriptLine } from './info-gaps/extract.js';
import { buildReport, type UnansweredItem } from './info-gaps/report.js';

/** Conversations read per 5-minute tick: MADI-sized runs (~30) finish in half an hour. */
export const EXTRACTIONS_PER_TICK = 5;
/** Output budget for one extraction (a JSON list; reasoning is off where the model allows). */
export const EXTRACTION_MAX_TOKENS = 2_000;
const MAX_ATTEMPTS = 3;
/** First run ever: look back this far. */
const FIRST_WINDOW_DAYS = 30;
const TRANSCRIPT_MESSAGES = 200;

export interface InfoGapRunResult {
  runsOpened: number;
  claimed: number;
  extracted: number;
  failed: number;
  runsFinished: number;
}

export interface PendingInfoAlertResult {
  found: number;
  escalated: number;
  failed: number;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Resolve a tenant by id (the loaders key on location id), memoized per tick. */
async function tenantLoader(): Promise<(tenantId: string) => Promise<TenantContext | null>> {
  const cache = new Map<string, TenantContext | null>();
  return async (tenantId) => {
    if (cache.has(tenantId)) return cache.get(tenantId) ?? null;
    const locationId = await getTenantGhlLocationId(tenantId);
    const tenant = locationId ? await loadTenantConfig(locationId) : null;
    cache.set(tenantId, tenant);
    return tenant;
  };
}

function renderHours(hours: unknown): string {
  if (!hours || typeof hours !== 'object') return '';
  const labels: Record<string, string> = {
    mon: 'Lunes', tue: 'Martes', wed: 'Miércoles', thu: 'Jueves', fri: 'Viernes', sat: 'Sábado', sun: 'Domingo',
  };
  return Object.entries(hours as Record<string, unknown>)
    .map(([day, ranges]) => {
      const parts = Array.isArray(ranges)
        ? ranges
            .filter((r): r is { open: string; close: string } => !!r && typeof r === 'object' && 'open' in r && 'close' in r)
            .map((r) => `${r.open}–${r.close}`)
        : [];
      return `- ${labels[day] ?? day}: ${parts.length > 0 ? parts.join(', ') : 'cerrado'}`;
    })
    .join('\n');
}

function offeringOf(tenant: TenantContext): string {
  const po = tenant.config.promptOverrides as { offering?: unknown } | null | undefined;
  return typeof po?.offering === 'string' ? po.offering : '';
}

function faqOf(tenant: TenantContext): { q: string; a: string }[] {
  const raw = tenant.config.faq as unknown;
  if (!Array.isArray(raw)) return [];
  return raw.filter((f): f is { q: string; a: string } =>
    !!f && typeof f === 'object' && typeof (f as { q?: unknown }).q === 'string' && typeof (f as { a?: unknown }).a === 'string');
}

function auxCallFor(tenant: TenantContext, clientId: string, ghlConversationId: string): AuxLlmCall {
  const provider = (tenant.config.provider ?? DEFAULT_PROVIDER) as AiProvider;
  const model = tenant.config.model ?? DEFAULT_MODEL;
  const key = resolveAiApiKey(provider, tenant.config.aiKeyRef);
  return { clientId, ghlConversationId, provider, apiKey: key.apiKey, model, keySource: key.source };
}

async function openDueRuns(now: Date): Promise<number> {
  let opened = 0;
  const tenants = await loadInfoGapTenants();
  for (const t of tenants) {
    const config = parseInfoGaps(t.infoGaps);
    if (!config || t.hasOpenRun) continue;
    const from = t.lastWindowTo
      ? new Date(t.lastWindowTo)
      : new Date(now.getTime() - FIRST_WINDOW_DAYS * 86_400_000);
    const candidates = await countInfoGapCandidates(t.clientId, from.toISOString(), now.toISOString());
    const lastStartedAt = t.lastStartedAt ? new Date(t.lastStartedAt) : null;
    if (!isRunDue(config, candidates, lastStartedAt, now)) continue;
    const runId = await openInfoGapRun(t.tenantId, t.clientId, from.toISOString(), now.toISOString());
    console.log(`[info-gaps] run ${runId} opened for tenant ${t.tenantId}: ${candidates} candidates`);
    opened++;
  }
  return opened;
}

async function drainExtractions(
  tenantFor: (tenantId: string) => Promise<TenantContext | null>,
): Promise<{ claimed: number; extracted: number; failed: number }> {
  const claimed = await claimInfoGapExtractions(EXTRACTIONS_PER_TICK);
  let extracted = 0;
  let failed = 0;

  for (const x of claimed) {
    const tenant = await tenantFor(x.tenantId);
    if (!tenant) {
      await completeInfoGapExtraction(x.id, 'failed', null, 'tenant_missing');
      failed++;
      continue;
    }

    try {
      const messages = await loadRecentMessages(x.conversationId, TRANSCRIPT_MESSAGES);
      const transcript: TranscriptLine[] = messages.map((m) => ({
        sender: m.senderType === 'lead' ? 'lead' : m.senderType === 'human_agent' ? 'human' : 'bot',
        at: m.sentAt,
        text: m.content,
      }));
      const prompt = buildExtractionPrompt({
        businessName: tenant.config.businessName,
        transcript,
        offering: offeringOf(tenant),
        faq: faqOf(tenant),
        hours: renderHours(tenant.config.hours),
      });
      const raw = await auxJsonCompletion(
        prompt,
        auxCallFor(tenant, x.clientId, x.ghlConversationId),
        'info_gap_extract',
        EXTRACTION_MAX_TOKENS,
      );
      const result = parseExtraction(raw);
      await completeInfoGapExtraction(x.id, 'done', result);
      extracted++;
    } catch (err) {
      const msg = errorMessage(err);
      if (x.attempts >= MAX_ATTEMPTS) {
        await completeInfoGapExtraction(x.id, 'failed', null, msg);
        await logBotEvent(x.clientId, x.ghlConversationId, 'info_gap_error', {
          stage: 'extract',
          runId: x.runId,
          error: msg,
        });
        console.error(`[info-gaps] extraction failed for good conv=${x.conversationId}: ${msg}`);
        failed++;
      } else {
        await completeInfoGapExtraction(x.id, 'pending', null, msg);
        console.error(`[info-gaps] extraction failed (attempt ${x.attempts}) conv=${x.conversationId}: ${msg}`);
      }
    }
  }

  return { claimed: claimed.length, extracted, failed };
}

function firstUnansweredQuestion(result: unknown): string | null {
  const gaps = (result as ExtractionResult | null)?.gaps;
  if (!Array.isArray(gaps)) return null;
  return gaps.find((g) => g.human_answer === null)?.question ?? gaps[0]?.question ?? null;
}

async function finalizeRun(
  run: FinalizableInfoGapRun,
  tenantFor: (tenantId: string) => Promise<TenantContext | null>,
): Promise<void> {
  const rows = await loadInfoGapExtractions(run.id);
  const done = rows.filter((r) => r.status === 'done' && r.result);
  const failed = rows.filter((r) => r.status === 'failed').length;

  const records: ExtractionRecord[] = done.map((r) => ({
    conversationId: r.conversationId,
    seenAt: r.lastMessageAt ?? run.windowTo,
    result: r.result as ExtractionResult,
  }));

  const touched = new Set<string>();
  for (const u of toUpserts(records)) {
    const status = await upsertInfoGap({ tenantId: run.tenantId, ...u });
    if (status !== 'dismissed') touched.add(u.topicKey);
  }

  // A queued question in a thread no human ever replied in: the lost-lead list.
  const unanswered: UnansweredItem[] = rows
    .filter((r) => r.reasons.includes('pending_info') && !r.reasons.includes('human_reply'))
    .map((r) => ({
      conversationId: r.conversationId,
      question: firstUnansweredQuestion(r.result),
      lastMessageAt: r.lastMessageAt,
    }));

  const tenant = await tenantFor(run.tenantId);
  const gaps = await loadInfoGaps(run.tenantId);
  const configChangedAt = await loadTenantConfigLastChange(run.tenantId);
  const { markdown, summary } = buildReport({
    businessName: tenant?.config.businessName ?? run.tenantId,
    runId: run.id,
    windowFrom: run.windowFrom,
    windowTo: run.windowTo,
    candidates: run.candidates,
    extracted: done.length,
    failed,
    gaps,
    touched,
    unanswered,
    configChangedAt,
  });
  await saveInfoGapReport(run.id, run.tenantId, markdown, { ...summary });
  await finishInfoGapRun(run.id, 'done', done.length, touched.size);
  console.log(`[info-gaps] run ${run.id} done: ${done.length} extracted, ${touched.size} gaps touched`);
}

export async function runInfoGapExtractions(now: Date = new Date()): Promise<InfoGapRunResult> {
  const tenantFor = await tenantLoader();
  const runsOpened = await openDueRuns(now);
  const drained = await drainExtractions(tenantFor);

  let runsFinished = 0;
  for (const run of await loadFinalizableInfoGapRuns()) {
    try {
      await finalizeRun(run, tenantFor);
      runsFinished++;
    } catch (err) {
      const msg = errorMessage(err);
      console.error(`[info-gaps] finalize failed run=${run.id}: ${msg}`);
      await finishInfoGapRun(run.id, 'failed', 0, 0);
    }
  }

  return { runsOpened, ...drained, runsFinished };
}

export async function runPendingInfoAlerts(): Promise<PendingInfoAlertResult> {
  const rows = await loadUnansweredPendingInfo();
  const clients = new Map<string, GhlClient>();
  let escalated = 0;
  let failed = 0;

  for (const r of rows) {
    let ghl = clients.get(r.tenantId);
    if (!ghl) {
      ghl = new GhlClient(r.tenantId);
      clients.set(r.tenantId, ghl);
    }
    try {
      await ghl.addContactTags(r.ghlContactId, [r.escalationTag]);
      await logBotEvent(r.clientId, r.ghlConversationId, 'pending_info_escalated', {
        tag: r.escalationTag,
        question: r.question,
        flaggedAt: r.flaggedAt,
      });
      escalated++;
    } catch (err) {
      const msg = errorMessage(err);
      console.error(`[info-gaps] escalation tag failed contact=${r.ghlContactId}: ${msg}`);
      await logBotEvent(r.clientId, r.ghlConversationId, 'info_gap_error', {
        stage: 'escalation',
        tag: r.escalationTag,
        error: msg,
      });
      failed++;
    }
  }

  return { found: rows.length, escalated, failed };
}
