/** A price in Mexican pesos as the bot writes it: "$500", "$ 3,500", "500 pesos", "500 MXN".
 *  Shared by the stage floor (0067) and the sequence cursor (0070); lives alone so
 *  followup-steps → stage → tenant → db/queries → followup-playbook doesn't form a cycle. */
const PRICE_RE = /\$\s?\d|\d\s?(pesos|mxn)\b/i;

export function mentionsPrice(text: string): boolean {
  return PRICE_RE.test(text);
}
