/**
 * HappyNatyNat — Análisis de Color Full (2026-10-07). Golden cases for what the tenant's text
 * must hold against the platform's defaults and the model's habits:
 *  1. Presentación (p2b) opens with value and a question — no price, no call yet. Cierre (c1)
 *     opens with the offer. Same flow underneath; only the first-message brief differs.
 *  2. Emojis. The platform format rule says "sin emojis (a menos que el lead los use)"; Nat's
 *     brand is warm and the tenant's `houseRules` "# Tono" overrides it.
 *  3. A selfie is never a color reading: the combination is what the session sells.
 *  4. The price, asked, is given straight ($4,850) — no "Nat te lo dice en la llamada".
 *  5. A lead writing in English gets English — even off c3's Spanish example, which is why
 *     c3 repeats the rule next to it (the house rule alone held 1 of 3).
 *
 * Each case has a switch that deletes the rule it defends (`HNN_OFF=<name>`), so the red side
 * can be measured: stage | emoji | photo | price | english.
 *
 *   MEDIDO 2026-10-07 en gpt-5.6-luna (seriado; con la regla · SIN ella):
 *   - emoji: 3/3 · 0/3 — la regla de plataforma "sin emojis" gana sin el "# Tono" del tenant.
 *   - english: 8/8 · 0/3 — sin la línea junto al ejemplo, c3 copia la lista en español.
 *   - c1 (oferta en el primer mensaje): 7/8 · 0/3 — sin el arranque abre con el método, sin oferta.
 *   - frase del anuncio + "[imagen]" (Adriana, p4, la primera lead en vivo): antes 0/3 —
 *     "gracias por mandármela, ¿qué me quisiste mostrar?" — · con la viñeta de "# Fotos del
 *     lead" (prompt.ts) y "# Su primer mensaje es solo la entrada" (houseRules) 5/5. Sin la
 *     viñeta de código 0/3: la regla del tenant sola no le gana a la de plataforma.
 *   - la misma imagen YA DESCRITA (el camino normal): 5/5 con todo · 3/3 sin la viñeta —
 *     ahí basta la regla del tenant.
 *   - p2b, selfie, precio: 3/3 · 3/3 — NO discriminan. El prompt base ya abre sin precio, el
 *     modelo no lee colores en una foto aunque falte la línea, y el `offering` trae el precio.
 *     Se quedan como guardias de que eso no cambie.
 *
 * Live cases need an API key (`pnpm eval`); excluded from the CI gate.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../db/queries.js');

const getAvailability = vi.fn();
vi.mock('../../../ghl/client.js', () => ({
  GhlClient: vi.fn(() => ({
    getAvailability,
    getContactAppointments: vi.fn().mockResolvedValue([]),
    addContactTags: vi.fn().mockResolvedValue(undefined),
  })),
}));

import * as q from '../../../db/queries.js';
import { buildFrontDeskAgent } from '../agent.js';
import { buildAgentRequestContext } from '../../../core/runtime-context.js';
import type { TenantContext, TurnContext } from '../../../core/types.js';
import { HAPPYNATY_PERSONA, HAPPYNATY_VARIANTS, happyNatyTenant } from './fixtures.js';
import { evalApiKey, evalModel, evalProvider } from './eval-model.js';

const OFF = process.env.HNN_OFF ?? '';

const dropLine = (text: string, startsWith: string): string => {
  const lines = text.split('\n');
  const kept = lines.filter((l) => !l.startsWith(startsWith));
  if (kept.length === lines.length) throw new Error(`line not found: ${startsWith}`);
  return kept.join('\n');
};
const dropSection = (text: string, title: string): string => {
  const start = text.indexOf(title);
  if (start < 0) throw new Error(`section not found: ${title}`);
  const next = text.indexOf('\n# ', start + 1);
  return (text.slice(0, start) + (next < 0 ? '' : text.slice(next + 1))).trim();
};

let houseRules = HAPPYNATY_PERSONA.houseRules;
if (OFF === 'emoji') houseRules = dropLine(houseRules, '- Cálida, cercana y empática');
if (OFF === 'photo') houseRules = dropLine(houseRules, '- No le digas a nadie sus colores');
if (OFF === 'english') houseRules = dropLine(houseRules, '- Contesta en el idioma');
const variants = Object.fromEntries(
  Object.entries(HAPPYNATY_VARIANTS).map(([k, v]) => [
    k,
    {
      ...v,
      qualificationNotes:
        OFF === 'price'
          ? dropSection(v.qualificationNotes, '# El precio')
          : OFF === 'english' && k === 'c3'
            ? dropLine(v.qualificationNotes, '- Si te escribe en inglés')
            : v.qualificationNotes,
    },
  ]),
);
// `stage` drops each ad's first-message brief: p2b and c1 both fall back to the base opener.
const stageOff = OFF === 'stage';

const tenant: TenantContext = {
  ...happyNatyTenant,
  config: {
    ...happyNatyTenant.config,
    promptOverrides: { ...HAPPYNATY_PERSONA, houseRules },
    promptVariants: stageOff ? null : variants,
  },
};

const turn = (variant: string): TurnContext => ({
  ghlConversationId: `conv_eval_hnn_${variant}`,
  ghlContactId: `contact_eval_hnn_${variant}`,
  contactPhone: '+526641234567',
  channel: 'whatsapp',
  promptVariant: variant,
});

type Msg = { role: 'user'; content: string } | { role: 'assistant'; content: string };
const run = async (variant: string, messages: Msg[]) => {
  const res = await buildFrontDeskAgent().generate(messages, {
    requestContext: buildAgentRequestContext({ tenant, turn: turn(variant), provider: evalProvider, model: evalModel, llmApiKey: evalApiKey }),
  });
  if (process.env.EVAL_DEBUG) console.log(`[eval ${variant}]`, res.text);
  return res.text.trim();
};

const nextTuesday = (): string => {
  const d = new Date(Date.now() + 24 * 60 * 60 * 1000);
  while (d.getUTCDay() !== 2) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};
const TUE = nextTuesday();
const SLOTS = [`${TUE}T10:00:00-07:00`, `${TUE}T15:00:00-07:00`].map((start) => ({ start, end: start }));

const PRICE = /4,?850/;
const CALL = /llamada|videollamada|meet/i;
const EMOJI = /\p{Extended_Pictographic}/u;
/** Treating the ad's image as hers: thanking for it, or asking what it was meant to show. */
const PHOTO_ACK = /(gracias|por) (la|tu|esta) (foto|imagen)|mand[aá]rmela|compartirla|mostrarme|quisiste|(la|esta) (foto|imagen) (es|era)|tu (foto|imagen)/i;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(q.logBotEvent).mockResolvedValue(undefined);
  vi.mocked(q.getActiveDemoSession).mockResolvedValue(null);
  getAvailability.mockResolvedValue(SLOTS);
});

describe.skipIf(!evalApiKey)(`HappyNatyNat — live${OFF ? ` (SIN ${OFF})` : ''}`, () => {
  it('p2b (presentación): explains and asks — no price, no call, no offer yet', async () => {
    const text = await run('p2b', [{ role: 'user', content: '¿Por qué la misma blusa se ve distinta según el color?' }]);
    expect(text).not.toMatch(PRICE);
    expect(text).not.toMatch(CALL);
    expect(text).not.toMatch(/120 minutos|gu[ií]a 3 en 1|paleta f[ií]sica/i);
    expect(text).toContain('?');
  });

  it('c1 (cierre): the offer comes in the first message', async () => {
    const text = await run('c1', [{ role: 'user', content: 'Quiero saber mis colores reales, sin filtro' }]);
    expect(text).toMatch(/telas reales/i);
    expect(text).toMatch(/120 minutos|paleta|gu[ií]a 3 en 1/i);
  });

  it('warm: the opener carries an emoji even though the lead used none', async () => {
    const text = await run('p8', [{ role: 'user', content: '¿Cómo puedo conocer mis colores?' }]);
    expect(text).toMatch(EMOJI);
  });

  it('a selfie gets no color reading — the session does that', async () => {
    const text = await run('c2', [
      { role: 'user', content: '¿Cuál es mi combinación de colores?' },
      {
        role: 'assistant',
        content:
          'Tu combinación sale de 6 características: profundo, cálido, frío, brillante, suave y luminoso. Cada persona tiene una principal, una secundaria y una terciaria, y eso es lo que Nat descubre en tu sesión con telas reales ✨ ¿Ya te habían dicho tu estación antes?',
      },
      {
        role: 'user',
        content:
          '[Foto que mandó: selfie de una mujer de piel morena clara, cabello castaño oscuro y ojos cafés, con blusa blanca y luz de ventana]\nNo, mira esta es mi foto, ¿qué colores crees que me quedan?',
      },
    ]);
    // A reading names her features or the colors that suit her; the rule is to send her to the session.
    expect(text).not.toMatch(/(eres|serías|pareces|te ves|tu piel es|tienes (un )?tono)\s+(m[aá]s\s+)?(c[aá]lid|fr[ií]|profund|suave|brillante|luminos|oto[nñ]o|invierno|primavera|verano)/i);
    expect(text).not.toMatch(/te (quedan|favorecen|van) (muy )?(bien )?(los|el|tonos|colores) (tierra|dorad|plateado|vino|camel|beige|neutro|pastel)/i);
    expect(text).toMatch(/sesi[oó]n|llamada|telas/i);
  });

  it('price asked: $4,850 straight, tied to the call', async () => {
    const text = await run('p4', [
      { role: 'user', content: '¿Qué color de tinte me favorece?' },
      {
        role: 'assistant',
        content:
          'El tono que te favorece depende de tus características de color: hay tonos que te iluminan y otros que te hacen ver cansada aunque se vean bonitos en la foto 💛 ¿Estás pensando en cambiar de color, o ya te pasó que uno no te quedó?',
      },
      { role: 'user', content: 'Ya me pasó jaja. Y cuánto cuesta el análisis?' },
    ]);
    expect(text).toMatch(PRICE);
  });

  it('ad phrase + the ad image: answers the phrase and moves on — never the photo', async () => {
    // Replying to an IG ad attaches the ad's own creative; the 2026-10-07 lead (Adriana, p4)
    // got "¿Me querías mostrar tu tono actual…?" instead of an answer to her question.
    const text = await run('p4', [
      { role: 'user', content: '¿Qué color de tinte me favorece?' },
      { role: 'user', content: '[imagen]' },
    ]);
    expect(text).not.toMatch(PHOTO_ACK);
    expect(text).toMatch(/caracter[ií]sticas/i);
    expect(text).toMatch(/an[aá]lisis/i);
    expect(text).toContain('?');
  });

  it('ad phrase + the ad image, described: still the ad, not her photo', async () => {
    const text = await run('p4', [
      { role: 'user', content: '¿Qué color de tinte me favorece?' },
      {
        role: 'user',
        content:
          '[Foto que mandó: gráfico publicitario con dos fotos de una mujer con distinto color de cabello y el texto "No era el cansancio, era el tono" y el logo de HappyNatyNat]',
      },
    ]);
    expect(text).not.toMatch(PHOTO_ACK);
    expect(text).toMatch(/caracter[ií]sticas/i);
    expect(text).toContain('?');
  });

  it('hair talk: Nat is a color consultant, not a stylist — the tone goes to her colorist', async () => {
    // Real p4 thread, 2026-10-08: the bot offered that "Nat puede explicarte cómo integrar tus
    // canas", which reads like a hair service.
    const text = await run('p4', [
      { role: 'user', content: '¿Qué color de tinte me favorece?' },
      {
        role: 'assistant',
        content:
          'Depende de tus características de color: hay tonos que iluminan tu rostro y otros que pueden marcar ojeras o endurecer tus facciones, aunque se vean preciosos en la foto. Por eso lo ideal es conocerlas con un Análisis de Color antes de teñirte 💛\n¿Estás pensando en cambiar de color o ya te pasó que un tinte no te quedó?',
      },
      { role: 'user', content: 'Cambiar de color esq tengo canas y no me gusta como se me ve' },
      {
        role: 'assistant',
        content: 'Ay, claro, las canas pueden cambiar muchísimo cómo se refleja un tinte junto a tu rostro; a casi todas nos pasa y tiene solución ✨\n¿Buscas cubrirlas por completo o integrarlas con un tono más natural?',
      },
      { role: 'user', content: 'Me gustaria integrarlas xq estoy harta de teñir el cabello' },
    ]);
    // The point is an explicit line that Nat doesn't do hair — a passing "tu colorista" isn't it.
    expect(text).toMatch(/no (es|somos) (estilista|colorista|un sal[oó]n)|no (ti[ñn]e|aplica|pinta|hace (el |tu )?tinte)/i);
    expect(text).toMatch(/colorista|estilista/i);
    expect(text).not.toMatch(/nat (te )?(puede )?(integra|ti[ñn]e|aplica|corrige|pinta)|c[oó]mo integrar tus canas/i);
  });

  it('English in, English out', async () => {
    const text = await run('c3', [{ role: 'user', content: 'Hi! I want to see everything the session includes, I live in San Diego' }]);
    expect(text).toMatch(/\b(the|your|and|session|colors?|includes?)\b/i);
    expect(text).not.toMatch(/\b(sesi[oó]n|incluye|colores|regalo)\b/i);
  });
});
