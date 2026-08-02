/**
 * Voice-note transcription.
 *
 * WhatsApp voice notes arrive as an `.ogg` URL on the inbound webhook. Chat models
 * don't take audio the way they take images, so a voice note has to become text
 * before the turn runs. This is a plain API call, NOT another agent: giving it its
 * own prompt/persona would only add a place for it to editorialize. It returns what
 * the lead said, verbatim, and the front-desk agent reads it like any other message.
 *
 * The GHL asset is public (verified: 206 + audio/ogg with no auth), so we fetch and
 * forward the bytes without needing the tenant's OAuth token.
 */

const TRANSCRIBE_URL = 'https://api.openai.com/v1/audio/transcriptions';
/** Whisper's own cap is 25 MB; a WhatsApp voice note is orders of magnitude smaller,
 *  so anything this large is not a voice note and isn't worth the spend. */
const MAX_BYTES = 20 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 20_000;

export interface TranscriptionResult {
  text: string;
  /** Seconds of audio, when the provider reports it — for cost visibility. */
  durationSec?: number;
}

/**
 * Download an audio URL and transcribe it. Returns null on ANY failure — a lost
 * transcription must degrade to "we got your voice note, tell me in text" rather
 * than blowing up the turn.
 */
export async function transcribeAudio(
  url: string,
  apiKey: string,
  model = 'gpt-4o-mini-transcribe',
): Promise<TranscriptionResult | null> {
  try {
    const audioRes = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!audioRes.ok) {
      console.error(`[transcribe] asset fetch failed: ${audioRes.status}`);
      return null;
    }
    const size = Number(audioRes.headers.get('content-length') ?? 0);
    if (size > MAX_BYTES) {
      console.error(`[transcribe] asset too large: ${size} bytes`);
      return null;
    }
    const blob = await audioRes.blob();
    if (blob.size === 0) return null;

    // Whisper-family endpoints pick the decoder from the filename extension, so the
    // name here is load-bearing — not cosmetic.
    const ext = /\.([a-z0-9]+)(?:\?|$)/i.exec(url)?.[1]?.toLowerCase() ?? 'ogg';
    const form = new FormData();
    form.append('file', blob, `audio.${ext}`);
    form.append('model', model);
    // The leads are Spanish-speaking; naming it avoids the model "detecting" English
    // on a short, noisy clip and transcribing gibberish.
    form.append('language', 'es');

    const res = await fetch(TRANSCRIBE_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}` },
      body: form,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error(`[transcribe] api ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return null;
    }
    const data = (await res.json()) as { text?: string; duration?: number };
    const text = data.text?.trim();
    if (!text) return null;
    return { text, durationSec: typeof data.duration === 'number' ? data.duration : undefined };
  } catch (e) {
    console.error('[transcribe] failed:', e instanceof Error ? e.message : String(e));
    return null;
  }
}
