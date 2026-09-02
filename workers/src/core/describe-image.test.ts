import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  IMAGE_DESCRIPTION_MODEL,
  buildImageDescriptionPrompt,
  bytesToBase64,
  describeImages,
  resolveImageMime,
} from './describe-image.js';

afterEach(() => vi.unstubAllGlobals());

describe('buildImageDescriptionPrompt', () => {
  it('names the business and its services, and forbids the diagnosis step', () => {
    const p = buildImageDescriptionPrompt({ businessName: 'Dr. Valdivia', terms: ['Botox', 'Ácido Hialurónico'] });
    expect(p).toContain('a Dr. Valdivia');
    expect(p).toContain('El negocio ofrece: Botox, Ácido Hialurónico.');
    expect(p).toContain('PROHIBIDO: diagnosticar');
    expect(p).toContain('recomendar o sugerir tratamientos');
    expect(p).toContain('líneas de marioneta');
  });

  it('speaks in the plural for an album and in the singular for one photo', () => {
    expect(buildImageDescriptionPrompt({}, 1)).toContain('esta foto');
    expect(buildImageDescriptionPrompt({}, 2)).toContain('estas fotos');
  });

  it('caps the service list so a long catalogue cannot crowd the instructions', () => {
    const terms = Array.from({ length: 30 }, (_, i) => `Servicio ${i}`);
    const p = buildImageDescriptionPrompt({ terms });
    expect(p).toContain('Servicio 11');
    expect(p).not.toContain('Servicio 12');
  });
});

describe('resolveImageMime', () => {
  it('trusts an image content-type header, parameters and case included', () => {
    expect(resolveImageMime('https://x/p', 'image/PNG; charset=binary')).toBe('image/png');
  });
  it('falls back to the URL extension when the header is generic', () => {
    expect(resolveImageMime('https://x/p.jpeg?sig=1', 'application/octet-stream')).toBe('image/jpeg');
    expect(resolveImageMime('https://x/p.webp', null)).toBe('image/webp');
  });
  it('rejects formats the vision API does not take (HEIC) instead of guessing', () => {
    expect(resolveImageMime('https://x/p.heic', 'image/heic')).toBeNull();
    expect(resolveImageMime('https://x/p.pdf', 'application/pdf')).toBeNull();
  });
});

describe('bytesToBase64', () => {
  it('encodes byte-exactly, past the chunk boundary', () => {
    const bytes = new Uint8Array(70_000).map((_, i) => i % 251);
    expect(bytesToBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'));
  });
});

describe('describeImages', () => {
  const asset = (type = 'image/jpeg', len = '3') => ({
    ok: true,
    headers: { get: (h: string) => (h === 'content-type' ? type : len) },
    arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
  });

  it('forwards the bytes inline to the fixed vision model and returns the trimmed text with usage', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(asset())
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: '  Parte baja del rostro;\n se ven surcos.  ' } }],
          usage: { prompt_tokens: 800, completion_tokens: 40 },
        }),
      });
    vi.stubGlobal('fetch', fetchMock);

    const out = await describeImages(['https://x.test/p.jpg'], 'k', { businessName: 'Clínica' });

    expect(out).toEqual({
      text: 'Parte baja del rostro; se ven surcos.',
      model: IMAGE_DESCRIPTION_MODEL,
      usage: { inputTokens: 800, outputTokens: 40, cachedInputTokens: 0 },
    });
    const [url, init] = fetchMock.mock.calls[1] as [string, { body: string; headers: Record<string, string> }];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect(init.headers.authorization).toBe('Bearer k');
    const body = JSON.parse(init.body);
    expect(body.model).toBe(IMAGE_DESCRIPTION_MODEL);
    expect(body.reasoning_effort).toBe('low');
    expect(body.max_completion_tokens).toBeGreaterThan(0);
    expect(body.messages[0].content[0]).toEqual({ type: 'text', text: expect.stringContaining('a Clínica') });
    expect(body.messages[0].content[1].image_url.url).toBe('data:image/jpeg;base64,AQID');
  });

  it('describes up to three images in ONE call and drops the rest of an album', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(asset()).mockResolvedValueOnce(asset()).mockResolvedValueOnce(asset())
      .mockResolvedValueOnce({ ok: true, json: async () => ({ choices: [{ message: { content: 'tres fotos' } }] }) });
    vi.stubGlobal('fetch', fetchMock);
    const out = await describeImages(['https://x/1.jpg', 'https://x/2.jpg', 'https://x/3.jpg', 'https://x/4.jpg'], 'k');
    expect(out?.text).toBe('tres fotos');
    expect(out?.usage).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(4);          // 3 assets + 1 vision call, never the 4th photo
    const body = JSON.parse((fetchMock.mock.calls[3] as [string, { body: string }])[1].body);
    expect(body.messages[0].content).toHaveLength(4);     // prompt + 3 images
    expect(body.messages[0].content[0].text).toContain('estas fotos');
  });

  it('returns null — never throws — when the asset is missing, oversized, unsupported, or the API fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404 }));
    expect(await describeImages(['https://x/p.jpg'], 'k')).toBeNull();

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(asset('image/jpeg', String(50 * 1024 * 1024))));
    expect(await describeImages(['https://x/p.jpg'], 'k')).toBeNull();

    const heic = vi.fn().mockResolvedValue(asset('image/heic'));
    vi.stubGlobal('fetch', heic);
    expect(await describeImages(['https://x/p.heic'], 'k')).toBeNull();
    expect(heic).toHaveBeenCalledTimes(1);                // no vision call for a format it can't take

    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(asset()).mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'boom' }));
    expect(await describeImages(['https://x/p.jpg'], 'k')).toBeNull();

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network')));
    expect(await describeImages(['https://x/p.jpg'], 'k')).toBeNull();
  });

  it('an empty description is a failure, not an empty message', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(asset())
      .mockResolvedValueOnce({ ok: true, json: async () => ({ choices: [{ message: { content: '' } }] }) }));
    expect(await describeImages(['https://x/p.jpg'], 'k')).toBeNull();
  });
});
