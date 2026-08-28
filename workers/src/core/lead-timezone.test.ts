import { describe, it, expect } from 'vitest';
import {
  timezoneFromPhone,
  timezoneFromPlace,
  frameTimeZone,
  zoneSuffix,
  zoneLabel,
  offsetMinutes,
  isValidTimeZone,
} from './lead-timezone.js';

describe('timezoneFromPhone', () => {
  it('maps the metros (2-digit LADA) to Centro', () => {
    expect(timezoneFromPhone('+525512345678')?.timezone).toBe('America/Mexico_City');
    expect(timezoneFromPhone('+523312345678')?.timezone).toBe('America/Mexico_City');
    expect(timezoneFromPhone('+528112345678')?.timezone).toBe('America/Mexico_City');
  });

  it('skips the legacy mobile `1` after +52 (the shape GHL actually stores)', () => {
    expect(timezoneFromPhone('+5215512345678')?.timezone).toBe('America/Mexico_City');
    expect(timezoneFromPhone('5216641234567')?.timezone).toBe('America/Tijuana');
  });

  it('maps the non-Centro LADAs by zone', () => {
    expect(timezoneFromPhone('+526641234567')?.timezone).toBe('America/Tijuana');
    expect(timezoneFromPhone('+526861234567')?.timezone).toBe('America/Tijuana');
    expect(timezoneFromPhone('+526621234567')?.timezone).toBe('America/Hermosillo');
    expect(timezoneFromPhone('+526671234567')?.timezone).toBe('America/Mazatlan');
    expect(timezoneFromPhone('+526241234567')?.timezone).toBe('America/Mazatlan');
    expect(timezoneFromPhone('+529981234567')?.timezone).toBe('America/Cancun');
    expect(timezoneFromPhone('+526561234567')?.timezone).toBe('America/Ciudad_Juarez');
    expect(timezoneFromPhone('+528991234567')?.timezone).toBe('America/Matamoros');
  });

  it('every other +52 LADA is Centro (the table only knows the exceptions)', () => {
    expect(timezoneFromPhone('+524431234567')?.timezone).toBe('America/Mexico_City'); // Morelia
    expect(timezoneFromPhone('+529991234567')?.timezone).toBe('America/Mexico_City'); // Mérida
    expect(timezoneFromPhone('+526141234567')?.timezone).toBe('America/Mexico_City'); // Chihuahua city (Centro since 2022)
  });

  it('tags the guess with source=phone', () => {
    expect(timezoneFromPhone('+526641234567')).toEqual({ timezone: 'America/Tijuana', source: 'phone' });
  });

  it('tolerates punctuation and spaces', () => {
    expect(timezoneFromPhone('+52 (664) 123-4567')?.timezone).toBe('America/Tijuana');
  });

  it('maps known US area codes and refuses unknown ones', () => {
    expect(timezoneFromPhone('+16195551234')?.timezone).toBe('America/Los_Angeles');
    expect(timezoneFromPhone('+17605551234')?.timezone).toBe('America/Los_Angeles');
    expect(timezoneFromPhone('+16025551234')?.timezone).toBe('America/Phoenix');
    expect(timezoneFromPhone('+12105551234')?.timezone).toBe('America/Chicago');
    expect(timezoneFromPhone('+13055551234')?.timezone).toBe('America/New_York');
    expect(timezoneFromPhone('+19075551234')).toBeNull(); // Alaska — not mapped
  });

  it('returns null for other countries, malformed numbers and empties', () => {
    expect(timezoneFromPhone('+59173123456')).toBeNull(); // Bolivia
    expect(timezoneFromPhone('+52664123')).toBeNull(); // too short
    expect(timezoneFromPhone('')).toBeNull();
    expect(timezoneFromPhone(null)).toBeNull();
    expect(timezoneFromPhone(undefined)).toBeNull();
  });
});

describe('timezoneFromPlace', () => {
  it('resolves states and cities, accent- and case-insensitive', () => {
    expect(timezoneFromPlace('Cancún')).toBe('America/Cancun');
    expect(timezoneFromPlace('estoy en cancun')).toBe('America/Cancun');
    expect(timezoneFromPlace('Querétaro')).toBe('America/Mexico_City');
    expect(timezoneFromPlace('HERMOSILLO, SONORA')).toBe('America/Hermosillo');
    expect(timezoneFromPlace('La clínica está en Tijuana')).toBe('America/Tijuana');
    expect(timezoneFromPlace('San Diego')).toBe('America/Los_Angeles');
  });

  it('longest key wins: Baja California Sur is not Baja California', () => {
    expect(timezoneFromPlace('Baja California Sur')).toBe('America/Mazatlan');
    expect(timezoneFromPlace('baja california')).toBe('America/Tijuana');
    expect(timezoneFromPlace('Ciudad de México')).toBe('America/Mexico_City');
    expect(timezoneFromPlace('Estado de México')).toBe('America/Mexico_City');
  });

  it('matches whole words only', () => {
    // "leon" inside "leona" must not resolve.
    expect(timezoneFromPlace('leona')).toBeNull();
    expect(timezoneFromPlace('León, Guanajuato')).toBe('America/Mexico_City');
  });

  it('accepts a valid IANA id verbatim and rejects a made-up one', () => {
    expect(timezoneFromPlace('America/Hermosillo')).toBe('America/Hermosillo');
    expect(timezoneFromPlace('America/Nowhere')).toBeNull();
  });

  it('returns null when nothing matches — the bot must ask, never guess', () => {
    expect(timezoneFromPlace('por acá')).toBeNull();
    expect(timezoneFromPlace('')).toBeNull();
    expect(timezoneFromPlace(null)).toBeNull();
  });
});

describe('frameTimeZone', () => {
  const tenant = { timezone: 'America/Tijuana', leadTimezoneEnabled: true };

  it('uses the lead zone only when the tenant opted in', () => {
    expect(frameTimeZone(tenant, { leadTimezone: 'America/Mexico_City' })).toBe('America/Mexico_City');
    expect(frameTimeZone({ ...tenant, leadTimezoneEnabled: false }, { leadTimezone: 'America/Mexico_City' })).toBe('America/Tijuana');
    expect(frameTimeZone({ timezone: 'America/Tijuana' }, { leadTimezone: 'America/Mexico_City' })).toBe('America/Tijuana');
  });

  it('falls back to the tenant zone when the lead zone is missing or invalid', () => {
    expect(frameTimeZone(tenant, { leadTimezone: null })).toBe('America/Tijuana');
    expect(frameTimeZone(tenant, null)).toBe('America/Tijuana');
    expect(frameTimeZone(tenant, { leadTimezone: 'Mars/Olympus' })).toBe('America/Tijuana');
  });
});

describe('offsetMinutes / zoneSuffix', () => {
  const summer = new Date('2026-08-28T18:00:00Z');
  const winter = new Date('2026-12-15T18:00:00Z');

  it('reads DST off Intl: Tijuana moves, Mexico City does not', () => {
    expect(offsetMinutes('America/Tijuana', summer)).toBe(-420);
    expect(offsetMinutes('America/Tijuana', winter)).toBe(-480);
    expect(offsetMinutes('America/Mexico_City', summer)).toBe(-360);
    expect(offsetMinutes('America/Mexico_City', winter)).toBe(-360);
    expect(offsetMinutes('Mars/Olympus', summer)).toBeNull();
  });

  it('labels a lead who reads a different clock', () => {
    expect(zoneSuffix('America/Mexico_City', 'America/Tijuana', summer)).toBe(' hora de Ciudad de México');
    expect(zoneSuffix('America/Cancun', 'America/Tijuana', summer)).toBe(' hora de Cancún');
  });

  it('stays silent when the clocks agree — by offset, not by name', () => {
    expect(zoneSuffix('America/Tijuana', 'America/Tijuana', summer)).toBe('');
    // Hermosillo and Tijuana agree in summer (both UTC-7) and split in winter.
    expect(zoneSuffix('America/Hermosillo', 'America/Tijuana', summer)).toBe('');
    expect(zoneSuffix('America/Hermosillo', 'America/Tijuana', winter)).toBe(' hora de Sonora');
  });

  it('names the zones a lead would recognise, and falls back to the IANA id', () => {
    expect(zoneLabel('America/Mexico_City')).toBe('Ciudad de México');
    expect(zoneLabel('America/Los_Angeles')).toBe('California');
    expect(zoneLabel('Europe/Madrid')).toBe('Europe/Madrid');
  });

  it('isValidTimeZone', () => {
    expect(isValidTimeZone('America/Tijuana')).toBe(true);
    expect(isValidTimeZone('Not/AZone')).toBe(false);
  });
});
