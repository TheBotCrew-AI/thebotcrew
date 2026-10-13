/**
 * The openers a conversation's bot messages already used, so the next nudge can be
 * told, deterministically, not to start the same way.
 *
 * Why code and not a prompt line: the reactivation prompt has asked "two messages
 * never start alike" since 2026-09-20 and the model ignored it — in Heriberto's
 * last 30 days ~200 of 851 nudges opened with a "Qué bueno que …" variant, three in
 * a row on the same thread. A list of the literal openers in front of the model is
 * what it respects; a principle is not.
 *
 * An opener is the first N words of a message, lowercased, punctuation and emoji
 * stripped, deduplicated in order of appearance.
 */

const OPENER_WORDS = 3;

export function openerOf(text: string, words = OPENER_WORDS): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, words)
    .join(' ');
}

/** Openers of the given bot messages, unique, in order; empty strings dropped. */
export function usedOpeners(botMessages: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of botMessages) {
    const o = openerOf(m);
    if (!o || seen.has(o)) continue;
    seen.add(o);
    out.push(o);
  }
  return out;
}
