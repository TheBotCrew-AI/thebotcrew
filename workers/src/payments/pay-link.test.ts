import { describe, it, expect } from 'vitest';
import {
  SHORT_CODE_ALPHABET,
  SHORT_CODE_LENGTH,
  fixPayLinks,
  newShortCode,
  normalizeShortCode,
  payLinkUrl,
  paymentLinkFor,
} from './pay-link.js';

const BASE = 'https://pago.example.com';
const CODE_RE = new RegExp(`^[${SHORT_CODE_ALPHABET}]{${SHORT_CODE_LENGTH}}$`);

describe('newShortCode', () => {
  it('is 10 chars from the look-alike-free lowercase alphabet, and not the same twice', () => {
    const a = newShortCode();
    const b = newShortCode();
    expect(a).toMatch(CODE_RE);
    expect(b).toMatch(CODE_RE);
    expect(a).not.toBe(b);
    for (const bad of '01ilo') expect(SHORT_CODE_ALPHABET).not.toContain(bad);
  });

  it('rejects bytes past the uniform limit instead of folding them (no modulo bias)', () => {
    // 248..255 must be skipped: with only those on offer, nothing is produced until a valid byte shows up.
    let calls = 0;
    const random = (buf: Uint8Array): Uint8Array => {
      calls++;
      buf.fill(calls === 1 ? 255 : 0);
      return buf;
    };
    expect(newShortCode(random)).toBe('a'.repeat(SHORT_CODE_LENGTH));
    expect(calls).toBe(2);
  });
});

describe('normalizeShortCode', () => {
  it('lowercases and trims; anything off-alphabet or off-length is null', () => {
    expect(normalizeShortCode(' ABCDEFGHJK ')).toBe('abcdefghjk');
    expect(normalizeShortCode('abcdefghj')).toBeNull(); // 9
    expect(normalizeShortCode('abcdefghjkm')).toBeNull(); // 11
    expect(normalizeShortCode('abcdefgh1k')).toBeNull(); // '1' is not in the alphabet
    expect(normalizeShortCode('')).toBeNull();
    expect(normalizeShortCode(null)).toBeNull();
    expect(normalizeShortCode("abcdefghjk' or 1=1")).toBeNull();
  });
});

describe('payLinkUrl / paymentLinkFor', () => {
  it('builds <base>/p/<code>, tolerating a trailing slash on the base', () => {
    expect(payLinkUrl(`${BASE}/`, 'abcdefghjk')).toBe(`${BASE}/p/abcdefghjk`);
  });
  it('a hold with a code gets the short link; one born before 0063 keeps its Stripe URL', () => {
    expect(paymentLinkFor({ shortCode: 'abcdefghjk', checkoutUrl: 'https://checkout.stripe.com/x' }, BASE)).toBe(`${BASE}/p/abcdefghjk`);
    expect(paymentLinkFor({ shortCode: null, checkoutUrl: 'https://checkout.stripe.com/x' }, BASE)).toBe('https://checkout.stripe.com/x');
  });
});

describe('fixPayLinks — the deterministic repair of what the model glued onto the link', () => {
  const url = `${BASE}/p/x7k2m9qwab`;

  it('leaves a clean link alone', () => {
    expect(fixPayLinks(`Paga aquí:\n${url}`, BASE)).toBe(`Paga aquí:\n${url}`);
  });

  it('cuts a doubled code (the 2026-09-22 shape) and trailing punctuation', () => {
    expect(fixPayLinks(`${url}x7k2m9qwab`, BASE)).toBe(url);
    expect(fixPayLinks(`${url}#x7k2m9qwab`, BASE)).toBe(url);
    expect(fixPayLinks(`Liga: ${url}.`, BASE)).toBe(`Liga: ${url}`);
    expect(fixPayLinks(`(${url})`, BASE)).toBe(`(${url}`);
  });

  it('repairs every link in the text and normalizes an autocapitalized code', () => {
    expect(fixPayLinks(`${url}zz y también ${BASE}/p/X7K2M9QWAB.`, BASE)).toBe(`${url} y también ${url}`);
  });

  it('never touches other URLs or a code it cannot recognize', () => {
    const other = 'https://checkout.stripe.com/c/pay/cs_test_abc#frag';
    expect(fixPayLinks(other, BASE)).toBe(other);
    expect(fixPayLinks(`${BASE}/p/tooshort`, BASE)).toBe(`${BASE}/p/tooshort`);
    expect(fixPayLinks(`${BASE}/pay/ok`, BASE)).toBe(`${BASE}/pay/ok`);
  });
});
