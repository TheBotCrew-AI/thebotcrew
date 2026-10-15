import { describe, it, expect } from 'vitest';
import { allowedFunnelTags, funnelPlan, normalizeFunnelStatus, parseFunnelTags, ymdInZone, type FunnelPlan } from './funnel-tags.js';

const RAW = {
  enabled: true,
  calendars: {
    'cal-val': { slug: 'valoracion', kind: 'assessment' },
    'cal-botox': { slug: 'botox', kind: 'treatment' },
    'cal-laser': { slug: 'laser-co2', kind: 'treatment' },
    'cal-bad': { slug: 'Mal Slug', kind: 'treatment' },
    'cal-bad2': { slug: 'x', kind: 'other' },
  },
  fields: { last_visit: 'fld-visit', last_treatment: { botox: 'fld-botox' } },
};
const CFG = parseFunnelTags(RAW)!;
const plan = (calendarId: string, status: 'scheduled' | 'showed' | 'noshow', currentTags: string[] = []) =>
  funnelPlan({ config: CFG, calendarId, status, dateYmd: '2026-10-15', currentTags }) as FunnelPlan;

describe('parseFunnelTags', () => {
  it('keeps valid calendars, drops malformed ones, reads field ids', () => {
    expect(Object.keys(CFG.calendars)).toEqual(['cal-val', 'cal-botox', 'cal-laser']);
    expect(CFG.fields).toEqual({ lastVisit: 'fld-visit', lastTreatment: { botox: 'fld-botox' } });
  });

  it('null when absent, disabled, or without a usable calendar', () => {
    expect(parseFunnelTags(null)).toBeNull();
    expect(parseFunnelTags({ ...RAW, enabled: false })).toBeNull();
    expect(parseFunnelTags({ enabled: true, calendars: { a: { slug: 'Bad', kind: 'treatment' } } })).toBeNull();
  });
});

describe('normalizeFunnelStatus — booked/confirmed/new are ONE step', () => {
  it('maps the GHL vocabulary', () => {
    expect(normalizeFunnelStatus('booked')).toBe('scheduled');
    expect(normalizeFunnelStatus('confirmed')).toBe('scheduled');
    expect(normalizeFunnelStatus('new')).toBe('scheduled');
    expect(normalizeFunnelStatus('showed')).toBe('showed');
    expect(normalizeFunnelStatus('noshow')).toBe('noshow');
    expect(normalizeFunnelStatus('cancelled')).toBeNull();
    expect(normalizeFunnelStatus(undefined)).toBeNull();
  });
});

describe('funnelPlan — the table', () => {
  it('scheduled / assessment: agendo:valoracion + every objecion:* the contact carries', () => {
    expect(plan('cal-val', 'scheduled', ['objecion:precio', 'objecion:tiempo', 'interes:botox'])).toEqual({
      add: ['agendo:valoracion'],
      remove: ['objecion:precio', 'objecion:tiempo'],
      fields: [],
    });
  });

  it('scheduled / treatment: agendo:<slug>, objections untouched', () => {
    expect(plan('cal-botox', 'scheduled', ['objecion:precio'])).toEqual({ add: ['agendo:botox'], remove: [], fields: [] });
  });

  it('showed / assessment: valorado, drops noshow:valoracion if present, writes ultima-visita', () => {
    expect(plan('cal-val', 'showed', ['agendo:valoracion', 'noshow:valoracion'])).toEqual({
      add: ['valorado'],
      remove: ['noshow:valoracion'],
      fields: [{ id: 'fld-visit', value: '2026-10-15' }],
    });
  });

  it('showed / treatment: paciente:<slug>, drops interes:/cotizo:/noshow: of that slug, both date fields', () => {
    expect(plan('cal-botox', 'showed', ['interes:botox', 'cotizo:botox', 'interes:laser-co2'])).toEqual({
      add: ['paciente:botox'],
      remove: ['interes:botox', 'cotizo:botox'],
      fields: [{ id: 'fld-botox', value: '2026-10-15' }, { id: 'fld-visit', value: '2026-10-15' }],
    });
  });

  it('showed / treatment without a last_treatment field writes only ultima-visita', () => {
    expect(plan('cal-laser', 'showed').fields).toEqual([{ id: 'fld-visit', value: '2026-10-15' }]);
  });

  it('noshow: noshow:<slug>, nothing else', () => {
    expect(plan('cal-val', 'noshow')).toEqual({ add: ['noshow:valoracion'], remove: [], fields: [] });
    expect(plan('cal-laser', 'noshow')).toEqual({ add: ['noshow:laser-co2'], remove: [], fields: [] });
  });

  it('noshow corrected to showed: the showed plan removes the noshow tag — no special case', () => {
    expect(plan('cal-laser', 'showed', ['noshow:laser-co2'])).toMatchObject({ add: ['paciente:laser-co2'], remove: ['noshow:laser-co2'] });
  });

  it('a tag already on the contact is not re-added', () => {
    expect(plan('cal-val', 'showed', ['valorado']).add).toEqual([]);
  });

  it('a calendar outside the map is ignored — never an invented slug', () => {
    expect(plan('cal-unknown', 'showed')).toEqual({ ignored: 'unknown_calendar' });
  });
});

describe('allowedFunnelTags — the allow-list a write is checked against', () => {
  it('is agendo:/noshow: per calendar, paciente: per treatment, plus valorado', () => {
    expect([...allowedFunnelTags(CFG)].sort()).toEqual([
      'agendo:botox', 'agendo:laser-co2', 'agendo:valoracion',
      'noshow:botox', 'noshow:laser-co2', 'noshow:valoracion',
      'paciente:botox', 'paciente:laser-co2',
      'valorado',
    ]);
  });
});

describe('ymdInZone', () => {
  it('renders the appointment date in the tenant clock, not UTC', () => {
    // 23:30 Tijuana on the 14th is 06:30 UTC on the 15th.
    expect(ymdInZone('2026-10-15T06:30:00Z', 'America/Tijuana')).toBe('2026-10-14');
  });
});
