import { describe, it, expect, afterEach } from 'vitest';
import {
  buildCapiEventId,
  buildCapiPayload,
  capiTokenSecretName,
  extractCtwaClid,
  normalizePhoneForCapi,
  parseMetaCapi,
  resolveCapiToken,
  resolveEventSpec,
  sha256Hex,
  type MetaCapiConfig,
} from './capi-config.js';

const validRaw = { dataset_id: '123456', page_id: '789', token_ref: 'MADI' };
const config = (o: Partial<MetaCapiConfig> = {}): MetaCapiConfig => ({
  datasetId: '123456',
  pageId: '789',
  tokenRef: 'MADI',
  ...o,
});

describe('parseMetaCapi', () => {
  it('accepts a minimal valid config', () => {
    expect(parseMetaCapi(validRaw)).toEqual({ datasetId: '123456', pageId: '789', tokenRef: 'MADI' });
  });

  it('null/undefined/junk → null (feature off)', () => {
    expect(parseMetaCapi(null)).toBeNull();
    expect(parseMetaCapi(undefined)).toBeNull();
    expect(parseMetaCapi('nope')).toBeNull();
    expect(parseMetaCapi([])).toBeNull();
    expect(parseMetaCapi(42)).toBeNull();
  });

  it('missing any of dataset_id/page_id/token_ref → null', () => {
    expect(parseMetaCapi({ page_id: '789', token_ref: 'MADI' })).toBeNull();
    expect(parseMetaCapi({ dataset_id: '123', token_ref: 'MADI' })).toBeNull();
    expect(parseMetaCapi({ dataset_id: '123', page_id: '789' })).toBeNull();
    expect(parseMetaCapi({ ...validRaw, dataset_id: '   ' })).toBeNull();
  });

  it('carries test_event_code through, trimmed; blank is dropped', () => {
    expect(parseMetaCapi({ ...validRaw, test_event_code: ' TEST123 ' })?.testEventCode).toBe('TEST123');
    expect(parseMetaCapi({ ...validRaw, test_event_code: '  ' })?.testEventCode).toBeUndefined();
  });

  it('parses event overrides: rename, value+currency, and false to disable', () => {
    const parsed = parseMetaCapi({
      ...validRaw,
      events: {
        lead_started: false,
        appointment_booked: { name: 'Purchase', value: 350, currency: 'mxn' },
      },
    });
    expect(parsed?.events).toEqual({
      lead_started: false,
      appointment_booked: { name: 'Purchase', value: 350, currency: 'MXN' },
    });
  });

  it('rejects an unknown Meta event name (that override is ignored, config survives)', () => {
    const parsed = parseMetaCapi({
      ...validRaw,
      events: { appointment_booked: { name: 'Schedule' } },
    });
    expect(parsed).not.toBeNull();
    expect(parsed?.events).toBeUndefined();
  });

  it('ignores unknown event kinds without breaking the config', () => {
    const parsed = parseMetaCapi({ ...validRaw, events: { made_up_kind: { name: 'Purchase' } } });
    expect(parsed).not.toBeNull();
    expect(parsed?.events).toBeUndefined();
  });
});

describe('capiTokenSecretName', () => {
  it('normalizes the slug like aiKeySecretName does', () => {
    expect(capiTokenSecretName('MADI')).toBe('META_CAPI_TOKEN__MADI');
    expect(capiTokenSecretName('madi skin-care')).toBe('META_CAPI_TOKEN__MADI_SKIN_CARE');
    expect(capiTokenSecretName('  --madi--  ')).toBe('META_CAPI_TOKEN__MADI');
  });

  it('junk that normalizes to nothing → null', () => {
    expect(capiTokenSecretName('  ')).toBeNull();
    expect(capiTokenSecretName('---')).toBeNull();
  });
});

describe('resolveCapiToken', () => {
  afterEach(() => {
    delete process.env.META_CAPI_TOKEN__MADI;
  });

  it('reads the tenant secret when present', () => {
    process.env.META_CAPI_TOKEN__MADI = 'EAAG-token';
    expect(resolveCapiToken('MADI')).toBe('EAAG-token');
  });

  it('missing secret → null, NO platform fallback (one advertiser per token)', () => {
    expect(resolveCapiToken('MADI')).toBeNull();
    expect(resolveCapiToken('---')).toBeNull();
  });
});

describe('resolveEventSpec — defaults and overrides', () => {
  it('platform defaults: lead_started→LeadSubmitted, appointment_booked→QualifiedLead', () => {
    expect(resolveEventSpec(config(), 'lead_started')).toEqual({ name: 'LeadSubmitted' });
    expect(resolveEventSpec(config(), 'appointment_booked')).toEqual({ name: 'QualifiedLead' });
  });

  it('conversation_completed is OFF unless explicitly configured', () => {
    expect(resolveEventSpec(config(), 'conversation_completed')).toBeNull();
    expect(
      resolveEventSpec(config({ events: { conversation_completed: { name: 'Purchase' } } }), 'conversation_completed'),
    ).toEqual({ name: 'Purchase' });
  });

  it('an override replaces the default; false disables a default-on kind', () => {
    const c = config({ events: { appointment_booked: { name: 'Purchase', value: 350, currency: 'MXN' }, lead_started: false } });
    expect(resolveEventSpec(c, 'appointment_booked')).toEqual({ name: 'Purchase', value: 350, currency: 'MXN' });
    expect(resolveEventSpec(c, 'lead_started')).toBeNull();
  });
});

describe('extractCtwaClid', () => {
  it('reads the real GHL contact attributionSource shape (verified live 2026-08-01)', () => {
    expect(
      extractCtwaClid({
        sessionSource: 'Paid Social',
        url: 'https://fb.me/6UUbUY2Td',
        medium: 'whatsapp',
        ctwaClid: 'AfjMi93Y-example',
        adName: 'Chatea con nosotros',
        adId: '120250989588970351',
      }),
    ).toBe('AfjMi93Y-example');
  });

  it('tolerates snake_case', () => {
    expect(extractCtwaClid({ ctwa_clid: 'Afj-snake' })).toBe('Afj-snake');
  });

  it('null/absent/empty → null', () => {
    expect(extractCtwaClid(null)).toBeNull();
    expect(extractCtwaClid(undefined)).toBeNull();
    expect(extractCtwaClid({ sessionSource: 'Organic' })).toBeNull();
    expect(extractCtwaClid({ ctwaClid: '  ' })).toBeNull();
    expect(extractCtwaClid('AfjRaw')).toBeNull();
  });
});

describe('buildCapiEventId', () => {
  it('is one per conversation per kind', () => {
    expect(buildCapiEventId('conv1', 'lead_started')).toBe('conv1:lead_started');
  });
});

describe('normalizePhoneForCapi', () => {
  it("strips to digits (Meta's ph format: country code + number, no '+')", () => {
    expect(normalizePhoneForCapi('+52 1 664-404-5316')).toBe('5216644045316');
  });

  it('too short → null', () => {
    expect(normalizePhoneForCapi('12345')).toBeNull();
  });
});

describe('sha256Hex', () => {
  it('matches a known vector', async () => {
    // echo -n "5216644045316" | shasum -a 256
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('buildCapiPayload', () => {
  it('ctwa_clid UNHASHED + page_id in user_data; phone hashed into ph[]', async () => {
    const payload = await buildCapiPayload({
      config: config(),
      spec: { name: 'LeadSubmitted' },
      ctwaClid: 'AfjMi93Y-example',
      phone: '+5216644045316',
    });
    expect(payload.user_data.ctwa_clid).toBe('AfjMi93Y-example'); // Meta requirement: never hash
    expect(payload.user_data.page_id).toBe('789');
    expect(payload.user_data.ph).toEqual([await sha256Hex('5216644045316')]);
    expect(payload.custom_data).toBeUndefined();
  });

  it('no phone → no ph key', async () => {
    const payload = await buildCapiPayload({ config: config(), spec: { name: 'LeadSubmitted' }, ctwaClid: 'x' });
    expect(payload.user_data.ph).toBeUndefined();
  });

  it('a spec with value adds custom_data (currency defaults to MXN)', async () => {
    const payload = await buildCapiPayload({
      config: config(),
      spec: { name: 'Purchase', value: 350 },
      ctwaClid: 'x',
    });
    expect(payload.custom_data).toEqual({ value: 350, currency: 'MXN' });
  });
});
