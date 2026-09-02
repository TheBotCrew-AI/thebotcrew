/**
 * Image description — the picture a lead sends becomes a short, neutral text.
 *
 * Mirror of `transcribe.ts`: a lead's photo arrives as a URL on the inbound webhook, and
 * the front-desk agent never sees pixels. A vision call turns the image into one to three
 * sentences that say what is shown, the description is written back over the "[imagen]"
 * placeholder, and every turn from then on reads it as ordinary text. Describing once at
 * ingest (rather than handing the image to the agent) keeps the history text-only for the
 * classifier, the reactivation prompt and the resume gate, avoids re-sending the bytes on
 * every turn of a 20-message window, and puts the one rule that matters — describe, never
 * diagnose — in a single prompt instead of in every role.
 *
 * The GHL asset is public (same host as the voice notes, fetched without auth), so the
 * bytes are downloaded here and forwarded inline: the provider never has to reach GHL.
 */

import type { TokenUsage } from './llm-usage.js';
import { usageFromOpenAiResponse } from './llm-usage.js';

const CHAT_URL = 'https://api.openai.com/v1/chat/completions';
/** Fixed on purpose: `tenant_config.ai_model` may name a model without image input, and
 *  a description is cheap enough that the tenant's choice buys nothing here. Priced in
 *  `model_pricing`, so the spend shows up per client like every other call. */
export const IMAGE_DESCRIPTION_MODEL = 'gpt-5-mini';
/** A WhatsApp photo is re-compressed by the app to well under a megabyte; anything this
 *  large is not a chat photo and the provider's own per-image limit is close by. */
const MAX_BYTES = 10 * 1024 * 1024;
/** Photos the provider accepts inline. HEIC/HEIF (iPhone originals) are not among them and
 *  degrade to the placeholder rather than to a 400 mid-turn. */
const SUPPORTED = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const EXT_MIME: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' };
const FETCH_TIMEOUT_MS = 20_000;
/** One to three sentences, plus the reasoning pass `low` spends before them. */
const MAX_COMPLETION_TOKENS = 700;
/** More than this in one message is an album, not a question — describe the first few. */
const MAX_IMAGES = 3;

export interface ImageDescriptionContext {
  businessName?: string;
  /** Service names — the vocabulary the description should reach for when it fits. */
  terms?: string[];
}

export interface ImageDescriptionResult {
  text: string;
  model: string;
  /** For `llm_usage`; null when the provider body carried none. */
  usage: TokenUsage | null;
}

/**
 * The prompt is the whole product here. It asks for what a receptionist who cannot see
 * the picture needs — which zone, framed how, pointing at what — in the trade's plain
 * names (líneas de marioneta, papada), and forbids the step the medical limit in every
 * tenant's rules forbids: diagnosing, recommending, or judging the person.
 */
export function buildImageDescriptionPrompt(ctx: ImageDescriptionContext = {}, imageCount = 1): string {
  const plural = imageCount > 1;
  const who = ctx.businessName?.trim() ? `a ${ctx.businessName.trim()}` : 'a un negocio';
  const terms = (ctx.terms ?? []).map((t) => t.trim()).filter(Boolean).slice(0, 12);
  return [
    `Un cliente mandó ${plural ? 'estas fotos' : 'esta foto'} por WhatsApp ${who}. Describe${plural ? 'las' : 'la'} para la recepcionista, que no puede ver imágenes y necesita saber qué le mostraron. Escribe en español, en 1 a 3 oraciones, en tercera persona y en lenguaje llano.`,
    `- Si es una parte del cuerpo: di qué zona se muestra (rostro completo, parte baja del rostro, cuello, abdomen…) y qué rasgo visible parece querer señalar: líneas o surcos y dónde van, manchas, textura, volumen, flacidez. Nómbralo con el término común de la estética cuando aplique (líneas de marioneta, surcos nasogenianos, patas de gallo, entrecejo, papada, ojeras). Si señala algo con el dedo, un círculo o una flecha, dilo.`,
    `- Si es una captura de pantalla, un documento, un anuncio o un producto: di qué es y transcribe el texto relevante (precios, nombre del tratamiento, fechas).`,
    `- Si está borrosa, oscura o no se distingue qué es, dilo tal cual.`,
    `PROHIBIDO: diagnosticar o nombrar condiciones médicas, recomendar o sugerir tratamientos, opinar si algo "se ve bien" o "necesita" algo, estimar la edad, y describir la identidad o el aspecto general de la persona (rasgos, atractivo, peso). Solo lo que se ve y lo que parece señalar.`,
    terms.length ? `El negocio ofrece: ${terms.join(', ')}.` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/** Bytes → base64 without blowing the call stack on a multi-megabyte photo. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** The MIME type to declare inline: the response header when it is an image type, else
 *  the URL extension. Null when neither names a format the provider accepts. */
export function resolveImageMime(url: string, contentType: string | null): string | null {
  const header = contentType?.split(';')[0]?.trim().toLowerCase() ?? '';
  if (SUPPORTED.has(header)) return header;
  const ext = /\.([a-z0-9]+)(?:\?|$)/i.exec(url)?.[1]?.toLowerCase() ?? '';
  return EXT_MIME[ext] ?? null;
}

async function fetchAsDataUrl(url: string): Promise<string | null> {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) {
    console.error(`[describe-image] asset fetch failed: ${res.status}`);
    return null;
  }
  const mime = resolveImageMime(url, res.headers.get('content-type'));
  if (!mime) {
    console.error(`[describe-image] unsupported format: ${res.headers.get('content-type') ?? url}`);
    return null;
  }
  const size = Number(res.headers.get('content-length') ?? 0);
  if (size > MAX_BYTES) {
    console.error(`[describe-image] asset too large: ${size} bytes`);
    return null;
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length === 0 || bytes.length > MAX_BYTES) return null;
  return `data:${mime};base64,${bytesToBase64(bytes)}`;
}

/**
 * Download the images and describe them in one call. Returns null on ANY failure —
 * a lost description degrades to "[imagen]" plus the prompt's "ask what they meant to
 * show", never to a broken turn.
 */
export async function describeImages(
  urls: string[],
  apiKey: string,
  context: ImageDescriptionContext = {},
  model = IMAGE_DESCRIPTION_MODEL,
): Promise<ImageDescriptionResult | null> {
  try {
    const dataUrls: string[] = [];
    for (const url of urls.slice(0, MAX_IMAGES)) {
      const dataUrl = await fetchAsDataUrl(url);
      if (dataUrl) dataUrls.push(dataUrl);
    }
    if (dataUrls.length === 0) return null;

    const res = await fetch(CHAT_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        max_completion_tokens: MAX_COMPLETION_TOKENS,
        reasoning_effort: 'low',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: buildImageDescriptionPrompt(context, dataUrls.length) },
              ...dataUrls.map((url) => ({ type: 'image_url', image_url: { url, detail: 'auto' } })),
            ],
          },
        ],
      }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS * 2),
    });
    if (!res.ok) {
      console.error(`[describe-image] api ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return null;
    }
    const data = (await res.json()) as { choices?: { message?: { content?: string | null } }[] };
    const text = data.choices?.[0]?.message?.content?.trim().replace(/\s+/g, ' ');
    if (!text) return null;
    return { text, model, usage: usageFromOpenAiResponse(data) };
  } catch (e) {
    console.error('[describe-image] failed:', e instanceof Error ? e.message : String(e));
    return null;
  }
}
