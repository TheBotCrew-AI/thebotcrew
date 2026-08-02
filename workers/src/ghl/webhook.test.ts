import { describe, it, expect } from 'vitest';
import {
  parseInboundWebhook,
  parseOutboundWebhook,
  parseContactTagWebhook,
  verifyDetached,
  verifyGhlWebhook,
} from './webhook.js';

const baseInbound = {
  type: 'InboundMessage',
  direction: 'inbound',
  locationId: 'loc1',
  contactId: 'c1',
  conversationId: 'conv1',
  body: 'hola',
};

describe('parseInboundWebhook', () => {
  it('parses a valid inbound message', () => {
    const r = parseInboundWebhook({ ...baseInbound, messageType: 'WhatsApp', phone: '+521' });
    expect(r).toMatchObject({ locationId: 'loc1', contactId: 'c1', conversationId: 'conv1', text: 'hola', channel: 'whatsapp', phone: '+521' });
  });

  it('returns null for non-InboundMessage type', () => {
    expect(parseInboundWebhook({ ...baseInbound, type: 'OutboundMessage' })).toBeNull();
  });

  it('returns null when direction is not inbound', () => {
    expect(parseInboundWebhook({ ...baseInbound, direction: 'outbound' })).toBeNull();
  });

  it('returns null when a required field is missing', () => {
    expect(parseInboundWebhook({ ...baseInbound, body: undefined })).toBeNull();
    expect(parseInboundWebhook({ ...baseInbound, contactId: undefined })).toBeNull();
  });

  it('falls back to `from` for the phone', () => {
    expect(parseInboundWebhook({ ...baseInbound, from: '+5219999' })?.phone).toBe('+5219999');
  });

  it('normalizes the channel (FB / IG / default WhatsApp)', () => {
    expect(parseInboundWebhook({ ...baseInbound, messageType: 'FB' })?.channel).toBe('facebook');
    expect(parseInboundWebhook({ ...baseInbound, messageType: 'IG' })?.channel).toBe('instagram');
    expect(parseInboundWebhook({ ...baseInbound, messageType: 'Instagram' })?.channel).toBe('instagram');
    expect(parseInboundWebhook({ ...baseInbound, messageType: 'SMS' })?.channel).toBe('whatsapp');
  });
});

describe('parseOutboundWebhook', () => {
  const base = {
    type: 'OutboundMessage',
    direction: 'outbound',
    source: 'app',
    locationId: 'loc1',
    contactId: 'c1',
    conversationId: 'conv1',
    body: 'reply',
    messageId: 'm1',
    userId: 'u1',
  };

  it('parses a human-sent (source: app) outbound message', () => {
    expect(parseOutboundWebhook(base)).toMatchObject({ contactId: 'c1', ghlUserId: 'u1', text: 'reply' });
  });

  it('skips bot echoes (source: api)', () => {
    expect(parseOutboundWebhook({ ...base, source: 'api' })).toBeNull();
  });

  it('skips when userId is missing', () => {
    expect(parseOutboundWebhook({ ...base, userId: undefined })).toBeNull();
  });
});

describe('parseContactTagWebhook', () => {
  it('parses + lowercases tags, reads contact id from `id`', () => {
    const r = parseContactTagWebhook({ type: 'ContactTagUpdate', locationId: 'loc1', id: 'c1', tags: ['Bot-Off', 'LEAD'] });
    expect(r).toEqual({ locationId: 'loc1', contactId: 'c1', tags: ['bot-off', 'lead'] });
  });

  it('returns null for the wrong type', () => {
    expect(parseContactTagWebhook({ type: 'ContactCreate', locationId: 'loc1', id: 'c1' })).toBeNull();
  });
});

// ── Signature verification (generated keypair round-trip) ─────────────────────

// Derive WebCrypto types from crypto.subtle itself (the Workers lib doesn't
// expose the global CryptoKey / AlgorithmIdentifier names).
type Subtle = typeof crypto.subtle;
type KeyPair = Extract<Awaited<ReturnType<Subtle['generateKey']>>, { privateKey: unknown }>;

async function genKey(alg: 'ed25519' | 'rsa') {
  const algo =
    alg === 'ed25519'
      ? { name: 'Ed25519' }
      : { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' };
  const kp = (await crypto.subtle.generateKey(
    algo as Parameters<Subtle['generateKey']>[0],
    true,
    ['sign', 'verify'],
  )) as KeyPair;
  // exportKey is overloaded (jwk → JsonWebKey); 'spki' always yields an ArrayBuffer.
  const spki = new Uint8Array((await crypto.subtle.exportKey('spki', kp.publicKey)) as ArrayBuffer);
  return { priv: kp.privateKey, pubB64: btoa(String.fromCharCode(...spki)) };
}

async function sign(priv: KeyPair['privateKey'], alg: 'ed25519' | 'rsa', body: string): Promise<string> {
  const algo = alg === 'ed25519' ? { name: 'Ed25519' } : { name: 'RSASSA-PKCS1-v1_5' };
  const sig = new Uint8Array(
    await crypto.subtle.sign(algo as Parameters<Subtle['sign']>[0], priv, new TextEncoder().encode(body)),
  );
  return btoa(String.fromCharCode(...sig));
}

describe.each(['ed25519', 'rsa'] as const)('verifyDetached (%s)', (alg) => {
  const body = JSON.stringify({ type: 'InboundMessage', body: 'hola' });

  it('accepts a valid signature', async () => {
    const { priv, pubB64 } = await genKey(alg);
    const sig = await sign(priv, alg, body);
    expect(await verifyDetached(body, sig, pubB64, alg)).toBe(true);
  });

  it('rejects a tampered body', async () => {
    const { priv, pubB64 } = await genKey(alg);
    const sig = await sign(priv, alg, body);
    expect(await verifyDetached(body + ' ', sig, pubB64, alg)).toBe(false);
  });

  it('rejects a signature from a different key', async () => {
    const a = await genKey(alg);
    const b = await genKey(alg);
    const sig = await sign(a.priv, alg, body);
    expect(await verifyDetached(body, sig, b.pubB64, alg)).toBe(false);
  });
});

describe('verifyGhlWebhook', () => {
  it('fails closed when no signature header is present', async () => {
    expect(await verifyGhlWebhook('{}', new Headers())).toBe(false);
  });

  it('fails closed on an invalid signature', async () => {
    expect(await verifyGhlWebhook('{}', new Headers({ 'x-ghl-signature': 'bm90LXZhbGlk' }))).toBe(false);
  });
});

describe('parseInboundWebhook — media-only messages (2026-08-01 regression)', () => {
  // Shape confirmed against the real GHL payload for the dropped voice note.
  const media = (attachments: unknown, body = '') => ({
    type: 'InboundMessage',
    direction: 'inbound',
    locationId: 'loc1',
    contactId: 'c1',
    conversationId: 'conv1',
    messageType: 'WhatsApp',
    body,
    attachments,
    messageId: 'm1',
  });

  it('a voice note with empty body is a REAL turn, not an unparseable payload', () => {
    const out = parseInboundWebhook(media(['https://x.test/a/44bbff3b.ogg']));
    expect(out).not.toBeNull();
    expect(out!.text).toBe('');
    expect(out!.attachments).toEqual([{ url: 'https://x.test/a/44bbff3b.ogg', kind: 'audio' }]);
  });

  it('classifies by extension, and query strings do not break it', () => {
    const out = parseInboundWebhook(media([
      'https://x.test/p.JPG?sig=abc',
      'https://x.test/v.opus',
      'https://x.test/doc.pdf',
    ]));
    expect(out!.attachments.map((a) => a.kind)).toEqual(['image', 'audio', 'file']);
  });

  it('keeps text when the lead sends a caption WITH the media', () => {
    const out = parseInboundWebhook(media(['https://x.test/p.png'], '¿cuánto por esto?'));
    expect(out!.text).toBe('¿cuánto por esto?');
    expect(out!.attachments).toHaveLength(1);
  });

  it('still rejects a genuinely empty message', () => {
    expect(parseInboundWebhook(media([], ''))).toBeNull();
    expect(parseInboundWebhook(media(undefined, ''))).toBeNull();
  });

  it('ignores junk entries instead of trusting the array blindly', () => {
    const out = parseInboundWebhook(media([null, 42, 'not-a-url', { nope: 1 }, 'https://x.test/ok.ogg']));
    expect(out!.attachments).toEqual([{ url: 'https://x.test/ok.ogg', kind: 'audio' }]);
  });

  it('tolerates {url} objects should GHL ever change shape', () => {
    const out = parseInboundWebhook(media([{ url: 'https://x.test/a.m4a' }]));
    expect(out!.attachments).toEqual([{ url: 'https://x.test/a.m4a', kind: 'audio' }]);
  });

  it('a plain text message still parses with an empty attachment list', () => {
    const out = parseInboundWebhook({
      type: 'InboundMessage', direction: 'inbound', locationId: 'loc1',
      contactId: 'c1', conversationId: 'conv1', body: 'hola', messageType: 'WhatsApp',
    });
    expect(out!.text).toBe('hola');
    expect(out!.attachments).toEqual([]);
  });
});
