/**
 * The lead's phone as typed into a Meta lead form, read from the message the form
 * drops into the Messenger / Instagram thread:
 *
 *   Hello! I filled out your form and would like to know more about your business.
 *   Full name: Antonio Salceda
 *   WhatsApp number: +526618505089
 *   ...
 *
 * A FB/IG contact carries no phone, but GHL dedups the form's lead by that number and
 * merges the thread's contact into it within seconds — so the phone is the only key the
 * send's merge recovery (GhlClient.sendMessage) can find the survivor by. Deterministic
 * on purpose: only a `label: value` line whose label names a phone and whose value is a
 * `+`-prefixed international number counts. A bare number with no country code is
 * ignored rather than guessed, since GHL's contact search matches the stored E.164 exactly.
 */
const PHONE_LABEL = /(whats\s*app|phone|tel[eé]fono|celular|m[oó]vil)/i;
const E164 = /^\+\d{10,15}$/;

export function phoneFromFormText(text: string | null | undefined): string | undefined {
  if (!text) return undefined;
  for (const line of text.split(/\r?\n/)) {
    const sep = line.lastIndexOf(':');
    if (sep <= 0) continue;
    const label = line.slice(0, sep);
    if (!PHONE_LABEL.test(label)) continue;
    const value = line.slice(sep + 1).replace(/[\s().-]/g, '');
    if (E164.test(value)) return value;
  }
  return undefined;
}
