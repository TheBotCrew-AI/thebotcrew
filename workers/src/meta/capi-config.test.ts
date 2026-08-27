import { describe, it, expect, afterEach } from 'vitest';
import {
  buildCapiEventId,
  buildCapiPayload,
  capiChannelFor,
  capiTokenSecretName,
  extractCapiIdentity,
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

  it('carries the optional WhatsApp / Instagram account ids (0056); blank is dropped', () => {
    const parsed = parseMetaCapi({
      ...validRaw,
      whatsapp_business_account_id: ' 1629186164979352 ',
      instagram_business_account_id: '17841475598106121',
    });
    expect(parsed?.whatsappBusinessAccountId).toBe('1629186164979352');
    expect(parsed?.instagramBusinessAccountId).toBe('17841475598106121');
    const blank = parseMetaCapi({ ...validRaw, whatsapp_business_account_id: '', instagram_business_account_id: '  ' });
    expect(blank?.whatsappBusinessAccountId).toBeUndefined();
    expect(blank?.instagramBusinessAccountId).toBeUndefined();
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

describe('capiChannelFor', () => {
  it("maps our channel enum to Meta's: facebook is 'messenger', the rest are themselves", () => {
    expect(capiChannelFor('facebook')).toBe('messenger');
    expect(capiChannelFor('whatsapp')).toBe('whatsapp');
    expect(capiChannelFor('instagram')).toBe('instagram');
  });
});

describe('extractCapiIdentity — the matching key per channel (0056)', () => {
  // Real GHL contact shapes, verified live 2026-08-26 on The Bot Crew's own leads.
  const fbPaid = {
    sessionSource: 'Paid Social',
    medium: 'facebook',
    mediumId: '36250000000000034',
    adId: '52510000000354',
    adSetId: '52510000000754',
    campaignId: '52510000000154',
    utmMedium: 'ACQ',
    pSid: '36250000000000034',
  };
  const igOrganic = { sessionSource: 'Social media', medium: 'instagram', mediumId: '1383000000000020', adId: null, igSid: '1383000000000020' };
  const waPaid = { sessionSource: 'Paid Social', medium: 'whatsapp', ctwaClid: 'AfjMi93Y-example', adId: '120250989588970351' };

  it('facebook → messenger + PSID', () => {
    expect(extractCapiIdentity('facebook', fbPaid)).toEqual({ channel: 'messenger', key: '36250000000000034' });
  });

  it('instagram → IGSID, even for an organic contact (adId null) — Meta does the attribution', () => {
    expect(extractCapiIdentity('instagram', igOrganic)).toEqual({ channel: 'instagram', key: '1383000000000020' });
  });

  it('whatsapp → the click id, exactly like extractCtwaClid', () => {
    expect(extractCapiIdentity('whatsapp', waPaid)).toEqual({ channel: 'whatsapp', key: 'AfjMi93Y-example' });
  });

  it("looks up the key for OUR channel, never for whatever the object carries", () => {
    // A WhatsApp conversation whose contact was first created from Facebook: no click id → nothing.
    expect(extractCapiIdentity('whatsapp', fbPaid)).toBeNull();
    // And a Facebook conversation never matches on a ctwa_clid.
    expect(extractCapiIdentity('facebook', waPaid)).toBeNull();
  });

  it('tolerates snake_case spellings', () => {
    expect(extractCapiIdentity('facebook', { page_scoped_user_id: '99' })).toEqual({ channel: 'messenger', key: '99' });
    expect(extractCapiIdentity('instagram', { ig_sid: '77' })).toEqual({ channel: 'instagram', key: '77' });
  });

  it('null/absent/empty → null', () => {
    expect(extractCapiIdentity('facebook', null)).toBeNull();
    expect(extractCapiIdentity('instagram', { sessionSource: 'Organic' })).toBeNull();
    expect(extractCapiIdentity('facebook', { pSid: '   ' })).toBeNull();
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
  const wa = { channel: 'whatsapp' as const, key: 'AfjMi93Y-example' };

  it('whatsapp: ctwa_clid UNHASHED + page_id in user_data; phone hashed into ph[]; channel frozen', async () => {
    const payload = await buildCapiPayload({
      config: config(),
      spec: { name: 'LeadSubmitted' },
      identity: wa,
      phone: '+5216644045316',
    });
    expect(payload?.messaging_channel).toBe('whatsapp');
    expect(payload?.user_data.ctwa_clid).toBe('AfjMi93Y-example'); // Meta requirement: never hash
    expect(payload?.user_data.page_id).toBe('789');
    expect(payload?.user_data.whatsapp_business_account_id).toBeUndefined(); // not configured
    expect(payload?.user_data.ph).toEqual([await sha256Hex('5216644045316')]);
    expect(payload?.custom_data).toBeUndefined();
  });

  it('whatsapp: the WABA id rides along when configured (what Meta’s own example sends)', async () => {
    const payload = await buildCapiPayload({
      config: config({ whatsappBusinessAccountId: '1629186164979352' }),
      spec: { name: 'LeadSubmitted' },
      identity: wa,
    });
    expect(payload?.user_data).toEqual({
      ctwa_clid: 'AfjMi93Y-example',
      page_id: '789',
      whatsapp_business_account_id: '1629186164979352',
    });
  });

  it('messenger: page_scoped_user_id + page_id, nothing WhatsApp-shaped', async () => {
    const payload = await buildCapiPayload({
      config: config(),
      spec: { name: 'LeadSubmitted' },
      identity: { channel: 'messenger', key: '36250000000000034' },
    });
    expect(payload).toEqual({
      messaging_channel: 'messenger',
      user_data: { page_scoped_user_id: '36250000000000034', page_id: '789' },
    });
  });

  it('instagram: ig_sid + ig_account_id (the wire name Meta enforces); WITHOUT the id → null (skip, not garbage)', async () => {
    const identity = { channel: 'instagram' as const, key: '1383000000000020' };
    expect(await buildCapiPayload({ config: config(), spec: { name: 'LeadSubmitted' }, identity })).toBeNull();
    const payload = await buildCapiPayload({
      config: config({ instagramBusinessAccountId: '17841475598106121' }),
      spec: { name: 'LeadSubmitted' },
      identity,
    });
    expect(payload).toEqual({
      messaging_channel: 'instagram',
      user_data: { ig_sid: '1383000000000020', ig_account_id: '17841475598106121' },
    });
  });

  it('no phone → no ph key', async () => {
    const payload = await buildCapiPayload({ config: config(), spec: { name: 'LeadSubmitted' }, identity: wa });
    expect(payload?.user_data.ph).toBeUndefined();
  });

  it('a spec with value adds custom_data (currency defaults to MXN)', async () => {
    const payload = await buildCapiPayload({
      config: config(),
      spec: { name: 'Purchase', value: 350 },
      identity: wa,
    });
    expect(payload?.custom_data).toEqual({ value: 350, currency: 'MXN' });
  });
});
