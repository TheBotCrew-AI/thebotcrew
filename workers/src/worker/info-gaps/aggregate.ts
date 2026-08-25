/**
 * Turn a run's per-conversation extractions into upserts against `info_gaps`.
 *
 * Deterministic on purpose — no second model call. Grouping is `topic` + a
 * normalized `topic_label`: lowercase, accents stripped, stopwords dropped, tokens
 * sorted, so "precio de piernas completas" and "piernas completas precio" are one
 * key. When labels still fragment in practice, the fix is a clustering pass over
 * the open rows — not a looser key here, which would merge unrelated gaps.
 */

import type { ExtractionResult, GapTarget, GapTopic } from './extract.js';

const STOPWORDS = new Set([
  'de', 'del', 'la', 'el', 'los', 'las', 'y', 'o', 'e', 'u', 'para', 'en', 'por', 'con',
  'un', 'una', 'unos', 'unas', 'al', 'a', 'que', 'se', 'su', 'sus', 'mi', 'mis', 'lo', 'le',
]);

export function normalizeLabel(label: string): string[] {
  const tokens = label
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 0 && !STOPWORDS.has(t));
  return [...new Set(tokens)].sort();
}

export function topicKey(topic: GapTopic, label: string): string {
  const tokens = normalizeLabel(label);
  return `${topic}:${tokens.length > 0 ? tokens.join('-') : 'general'}`;
}

export interface ExtractionRecord {
  conversationId: string;
  /** When the conversation was active — stamps first_seen/last_seen. */
  seenAt: string;
  result: ExtractionResult;
}

export interface GapUpsert {
  topicKey: string;
  topic: GapTopic;
  topicLabel: string;
  target: GapTarget;
  question: string;
  humanAnswer: string | null;
  suggestedText: string | null;
  seenAt: string;
  conversationId: string;
}

/**
 * One upsert per (conversation, topic): a lead who asked the same thing five times
 * is one occurrence, not five. Within a conversation the entry WITH a human answer
 * wins, since that is the payload the report is for. `already_in_config` overrides
 * the model's own target — that verdict is the whole point of sending the config.
 */
export function toUpserts(records: ExtractionRecord[]): GapUpsert[] {
  const byKey = new Map<string, GapUpsert>();
  for (const rec of records) {
    for (const gap of rec.result.gaps) {
      const key = topicKey(gap.topic, gap.topic_label);
      const mapKey = `${rec.conversationId}|${key}`;
      const target: GapTarget = gap.already_in_config ? 'prompt_bug' : gap.target;
      const candidate: GapUpsert = {
        topicKey: key,
        topic: gap.topic,
        topicLabel: gap.topic_label.trim(),
        target,
        question: gap.question.trim(),
        humanAnswer: gap.human_answer,
        suggestedText: target === 'prompt_bug' || target === 'none' ? null : gap.suggested_text,
        seenAt: rec.seenAt,
        conversationId: rec.conversationId,
      };
      const existing = byKey.get(mapKey);
      if (!existing || (!existing.humanAnswer && candidate.humanAnswer)) {
        byKey.set(mapKey, candidate);
      }
    }
  }
  return [...byKey.values()];
}
