/**
 * Parses the reactivation agent's reply under the hybrid angle-selection protocol.
 *
 * When given a candidate list, the agent is told to emit `ANGULO: n` on the first
 * line (its chosen 1-based candidate), then the message. We parse that here — and
 * always strip any tag so it can never leak to the lead. Pure and unit-tested.
 */

const TAG = /^\s*ANGULO:\s*(\d+)\s*(?:\r?\n|$)/i;

export interface AngleSelection {
  /** 1-based candidate number the agent chose, or null (invalid/absent/free-form). */
  angleChoice: number | null;
  /** The lead-facing message, with any selection tag stripped. */
  message: string;
}

export function parseAngleSelection(text: string, candidateCount: number): AngleSelection {
  const match = TAG.exec(text);
  let message = match ? text.slice(match[0].length) : text;
  // Defensive: strip a residual leading tag even if the first match didn't fire.
  message = message.replace(TAG, '').trim();

  let angleChoice: number | null = null;
  if (match) {
    const n = Number(match[1]);
    if (Number.isInteger(n) && n >= 1 && n <= candidateCount) angleChoice = n;
  }
  return { angleChoice, message };
}
