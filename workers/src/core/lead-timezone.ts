/**
 * The lead's timezone — which clock an appointment time is rendered in.
 *
 * Every hour the bot shows is formatted from an instant with an IANA zone; this
 * module decides WHICH zone. For an in-person business it is the tenant's. For a
 * remote service (a video call) it is the lead's, and the lead can be anywhere
 * in the country: Mexico spans four zones and only one of them follows US DST.
 *
 * Two sources, in order of trust:
 *   - what the lead said ("estoy en Cancún") → `timezoneFromPlace`, source 'lead';
 *   - the WhatsApp number's area code (LADA) → `timezoneFromPhone`, source 'phone'.
 * The precedence between them is enforced by the `app_set_lead_timezone` RPC.
 *
 * Nothing here converts a wall-clock by hand: the zone is fed to `Intl` /
 * `booking-time.ts`, which is what makes the DST cases (Tijuana vs. Mexico City
 * are one hour apart in summer, two in winter) come out right without a table.
 */

/** IANA zones used in Mexico (since the 2022 DST repeal) + the US zones we can name. */
const MX_CENTRO = 'America/Mexico_City';
const MX_PACIFICO = 'America/Mazatlan';
const MX_SONORA = 'America/Hermosillo';
const MX_NOROESTE = 'America/Tijuana';
const MX_SURESTE = 'America/Cancun';
const MX_JUAREZ = 'America/Ciudad_Juarez';
const MX_OJINAGA = 'America/Ojinaga';
const MX_MATAMOROS = 'America/Matamoros';
const US_PACIFIC = 'America/Los_Angeles';
const US_MOUNTAIN = 'America/Denver';
const US_ARIZONA = 'America/Phoenix';
const US_CENTRAL = 'America/Chicago';
const US_EASTERN = 'America/New_York';

/**
 * Mexican 3-digit LADAs that are NOT on Centro time. Everything else under +52
 * (including the 2-digit metros 55/56/33/81) is `America/Mexico_City`, so the
 * table only has to know the exceptions.
 */
const MX_LADA_TZ: Record<string, string> = {
  // Baja California — Pacific with US DST.
  '616': MX_NOROESTE, '646': MX_NOROESTE, '658': MX_NOROESTE,
  '661': MX_NOROESTE, '663': MX_NOROESTE, '664': MX_NOROESTE, '665': MX_NOROESTE, '686': MX_NOROESTE,
  // Baja California Sur — Pacífico, no DST.
  '612': MX_PACIFICO, '613': MX_PACIFICO, '615': MX_PACIFICO, '624': MX_PACIFICO,
  // Sonora — Pacífico, no DST (its own zone: it never observed DST).
  '622': MX_SONORA, '631': MX_SONORA, '632': MX_SONORA, '633': MX_SONORA, '634': MX_SONORA,
  '637': MX_SONORA, '638': MX_SONORA, '641': MX_SONORA, '642': MX_SONORA, '644': MX_SONORA,
  '645': MX_SONORA, '647': MX_SONORA, '653': MX_SONORA, '662': MX_SONORA,
  // Sinaloa — Pacífico.
  '667': MX_PACIFICO, '668': MX_PACIFICO, '669': MX_PACIFICO, '687': MX_PACIFICO,
  '694': MX_PACIFICO, '695': MX_PACIFICO, '696': MX_PACIFICO, '697': MX_PACIFICO,
  // Nayarit — Pacífico (Bahía de Banderas, LADA 329, is on Centro with Vallarta).
  '311': MX_PACIFICO, '319': MX_PACIFICO, '323': MX_PACIFICO, '324': MX_PACIFICO,
  '325': MX_PACIFICO, '327': MX_PACIFICO,
  // Chihuahua border municipalities that follow US DST (the rest of the state is on Centro).
  '656': MX_JUAREZ, '626': MX_OJINAGA,
  // Tamaulipas / Coahuila border strip — Central with US DST.
  '867': MX_MATAMOROS, '868': MX_MATAMOROS, '877': MX_MATAMOROS, '878': MX_MATAMOROS, '899': MX_MATAMOROS,
  // Quintana Roo — Sureste.
  '983': MX_SURESTE, '984': MX_SURESTE, '987': MX_SURESTE, '998': MX_SURESTE,
};

/** US area codes we see (border and diaspora). Unknown ones return null — the bot asks. */
const US_AREA_TZ: Record<string, string> = {
  // California
  '213': US_PACIFIC, '310': US_PACIFIC, '323': US_PACIFIC, '408': US_PACIFIC, '415': US_PACIFIC,
  '424': US_PACIFIC, '442': US_PACIFIC, '510': US_PACIFIC, '559': US_PACIFIC, '562': US_PACIFIC,
  '619': US_PACIFIC, '626': US_PACIFIC, '650': US_PACIFIC, '657': US_PACIFIC, '661': US_PACIFIC,
  '714': US_PACIFIC, '760': US_PACIFIC, '805': US_PACIFIC, '818': US_PACIFIC, '831': US_PACIFIC,
  '858': US_PACIFIC, '909': US_PACIFIC, '916': US_PACIFIC, '925': US_PACIFIC, '949': US_PACIFIC,
  '951': US_PACIFIC,
  // Nevada / Washington / Oregon
  '702': US_PACIFIC, '725': US_PACIFIC, '206': US_PACIFIC, '503': US_PACIFIC,
  // Arizona — no DST
  '480': US_ARIZONA, '520': US_ARIZONA, '602': US_ARIZONA, '623': US_ARIZONA, '928': US_ARIZONA,
  // Colorado / Utah / New Mexico / El Paso
  '303': US_MOUNTAIN, '720': US_MOUNTAIN, '801': US_MOUNTAIN, '505': US_MOUNTAIN, '915': US_MOUNTAIN,
  // Texas (Central) / Illinois
  '210': US_CENTRAL, '214': US_CENTRAL, '254': US_CENTRAL, '281': US_CENTRAL, '346': US_CENTRAL,
  '361': US_CENTRAL, '409': US_CENTRAL, '469': US_CENTRAL, '512': US_CENTRAL, '682': US_CENTRAL,
  '713': US_CENTRAL, '737': US_CENTRAL, '806': US_CENTRAL, '817': US_CENTRAL, '830': US_CENTRAL,
  '832': US_CENTRAL, '903': US_CENTRAL, '936': US_CENTRAL, '940': US_CENTRAL, '956': US_CENTRAL,
  '972': US_CENTRAL, '979': US_CENTRAL, '312': US_CENTRAL, '773': US_CENTRAL,
  // Florida / New York / Georgia / North Carolina
  '305': US_EASTERN, '321': US_EASTERN, '407': US_EASTERN, '561': US_EASTERN, '754': US_EASTERN,
  '786': US_EASTERN, '813': US_EASTERN, '954': US_EASTERN, '212': US_EASTERN, '347': US_EASTERN,
  '646': US_EASTERN, '718': US_EASTERN, '917': US_EASTERN, '404': US_EASTERN, '678': US_EASTERN,
  '704': US_EASTERN, '980': US_EASTERN,
};

/**
 * Where a lead is, by state / city, resolved to a zone in code. Keys are
 * accent-stripped lowercase; a longer key wins so "baja california sur" is not
 * read as "baja california". Only states and the cities a lead would actually
 * name — the point is a deterministic lookup, not a gazetteer.
 */
const PLACE_TZ: Record<string, string> = {
  // Zona Noroeste
  'baja california': MX_NOROESTE, 'bc': MX_NOROESTE, 'tijuana': MX_NOROESTE, 'mexicali': MX_NOROESTE,
  'ensenada': MX_NOROESTE, 'tecate': MX_NOROESTE, 'rosarito': MX_NOROESTE,
  // Zona Pacífico
  'baja california sur': MX_PACIFICO, 'bcs': MX_PACIFICO, 'la paz': MX_PACIFICO, 'los cabos': MX_PACIFICO,
  'cabo san lucas': MX_PACIFICO, 'san jose del cabo': MX_PACIFICO,
  'sinaloa': MX_PACIFICO, 'culiacan': MX_PACIFICO, 'mazatlan': MX_PACIFICO, 'los mochis': MX_PACIFICO,
  'nayarit': MX_PACIFICO, 'tepic': MX_PACIFICO,
  'sonora': MX_SONORA, 'hermosillo': MX_SONORA, 'ciudad obregon': MX_SONORA, 'obregon': MX_SONORA,
  'nogales': MX_SONORA, 'guaymas': MX_SONORA, 'san luis rio colorado': MX_SONORA,
  // Zona Sureste
  'quintana roo': MX_SURESTE, 'cancun': MX_SURESTE, 'playa del carmen': MX_SURESTE, 'tulum': MX_SURESTE,
  'cozumel': MX_SURESTE, 'chetumal': MX_SURESTE,
  // Border cities on US DST
  'ciudad juarez': MX_JUAREZ, 'juarez': MX_JUAREZ, 'ojinaga': MX_OJINAGA,
  'matamoros': MX_MATAMOROS, 'reynosa': MX_MATAMOROS, 'nuevo laredo': MX_MATAMOROS,
  'piedras negras': MX_MATAMOROS, 'ciudad acuna': MX_MATAMOROS, 'acuna': MX_MATAMOROS,
  // Zona Centro — the remaining states (and the cities that come up).
  'aguascalientes': MX_CENTRO, 'campeche': MX_CENTRO, 'chiapas': MX_CENTRO, 'chihuahua': MX_CENTRO,
  'coahuila': MX_CENTRO, 'colima': MX_CENTRO, 'ciudad de mexico': MX_CENTRO, 'cdmx': MX_CENTRO,
  'df': MX_CENTRO, 'mexico': MX_CENTRO, 'estado de mexico': MX_CENTRO, 'edomex': MX_CENTRO,
  'durango': MX_CENTRO, 'guanajuato': MX_CENTRO, 'guerrero': MX_CENTRO, 'hidalgo': MX_CENTRO,
  'jalisco': MX_CENTRO, 'michoacan': MX_CENTRO, 'morelos': MX_CENTRO, 'nuevo leon': MX_CENTRO,
  'oaxaca': MX_CENTRO, 'puebla': MX_CENTRO, 'queretaro': MX_CENTRO, 'san luis potosi': MX_CENTRO,
  'tabasco': MX_CENTRO, 'tamaulipas': MX_CENTRO, 'tlaxcala': MX_CENTRO, 'veracruz': MX_CENTRO,
  'yucatan': MX_CENTRO, 'zacatecas': MX_CENTRO,
  'guadalajara': MX_CENTRO, 'gdl': MX_CENTRO, 'monterrey': MX_CENTRO, 'mty': MX_CENTRO,
  'leon': MX_CENTRO, 'merida': MX_CENTRO, 'toluca': MX_CENTRO, 'cuernavaca': MX_CENTRO,
  'acapulco': MX_CENTRO, 'torreon': MX_CENTRO, 'saltillo': MX_CENTRO, 'tampico': MX_CENTRO,
  'puerto vallarta': MX_CENTRO, 'vallarta': MX_CENTRO, 'morelia': MX_CENTRO, 'villahermosa': MX_CENTRO,
  // US
  'san diego': US_PACIFIC, 'los angeles': US_PACIFIC, 'california': US_PACIFIC, 'las vegas': US_PACIFIC,
  'phoenix': US_ARIZONA, 'arizona': US_ARIZONA, 'tucson': US_ARIZONA,
  'el paso': US_MOUNTAIN, 'denver': US_MOUNTAIN,
  'texas': US_CENTRAL, 'houston': US_CENTRAL, 'dallas': US_CENTRAL, 'san antonio': US_CENTRAL,
  'austin': US_CENTRAL, 'chicago': US_CENTRAL,
  'miami': US_EASTERN, 'florida': US_EASTERN, 'orlando': US_EASTERN, 'nueva york': US_EASTERN,
  'new york': US_EASTERN, 'atlanta': US_EASTERN,
};

/** Spanish label for the suffix the bot prints next to an hour. Unknown zone → its IANA name. */
const ZONE_LABEL: Record<string, string> = {
  [MX_CENTRO]: 'Ciudad de México',
  [MX_PACIFICO]: 'Sinaloa / Baja California Sur',
  [MX_SONORA]: 'Sonora',
  [MX_NOROESTE]: 'Tijuana',
  [MX_SURESTE]: 'Cancún',
  [MX_JUAREZ]: 'Ciudad Juárez',
  [MX_OJINAGA]: 'Ojinaga',
  [MX_MATAMOROS]: 'la frontera de Tamaulipas',
  [US_PACIFIC]: 'California',
  [US_MOUNTAIN]: 'las Montañas (EE.UU.)',
  [US_ARIZONA]: 'Arizona',
  [US_CENTRAL]: 'Texas',
  [US_EASTERN]: 'Miami',
};

const PLACE_KEYS_LONGEST_FIRST = Object.keys(PLACE_TZ).sort((a, b) => b.length - a.length);

export type LeadTimezoneSource = 'phone' | 'lead';

export interface LeadTimezoneGuess {
  timezone: string;
  source: LeadTimezoneSource;
}

/** True when `Intl` knows the zone — the only validation a model-typed IANA string gets. */
export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * The zone a phone number's area code implies. Accepts E.164 with or without `+`
 * and whatever punctuation GHL sends. Mexican numbers may carry the legacy `1`
 * mobile prefix after the country code (`52 1 55…`), which is skipped. Returns
 * null for a country we don't map or an area code we don't know — the bot asks.
 */
export function timezoneFromPhone(phone: string | null | undefined): LeadTimezoneGuess | null {
  const digits = (phone ?? '').replace(/\D/g, '');
  if (!digits) return null;

  if (digits.startsWith('52')) {
    let national = digits.slice(2);
    if (national.length === 11 && national.startsWith('1')) national = national.slice(1);
    if (national.length !== 10) return null;
    const two = national.slice(0, 2);
    if (two === '55' || two === '56' || two === '33' || two === '81') {
      return { timezone: MX_CENTRO, source: 'phone' };
    }
    const three = national.slice(0, 3);
    return { timezone: MX_LADA_TZ[three] ?? MX_CENTRO, source: 'phone' };
  }

  if (digits.startsWith('1') && digits.length === 11) {
    const tz = US_AREA_TZ[digits.slice(1, 4)];
    return tz ? { timezone: tz, source: 'phone' } : null;
  }

  return null;
}

function normalizePlace(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The zone for a place the lead named — a state, a city, or (from the tool) a
 * valid IANA id. Longest key wins, whole-word, so "estoy en Baja California Sur"
 * lands on Pacífico and "cd de mexico" is not read as the state "mexico" before
 * the city is tried. Null when nothing matches: the bot must not guess.
 */
export function timezoneFromPlace(text: string | null | undefined): string | null {
  const raw = (text ?? '').trim();
  if (!raw) return null;
  if (/^[A-Za-z]+\/[A-Za-z_]+(\/[A-Za-z_]+)?$/.test(raw) && isValidTimeZone(raw)) return raw;

  const norm = ` ${normalizePlace(raw)} `;
  for (const key of PLACE_KEYS_LONGEST_FIRST) {
    if (norm.includes(` ${key} `)) return PLACE_TZ[key]!;
  }
  return null;
}

/**
 * Which zone to render times in for this conversation. Only a tenant that
 * opted in (a remote service) ever sees the lead's zone; for everyone else the
 * answer is the tenant's, exactly as before this module existed.
 */
export function frameTimeZone(
  tenant: { timezone: string; leadTimezoneEnabled?: boolean },
  conversation: { leadTimezone?: string | null } | null | undefined,
): string {
  const lead = conversation?.leadTimezone;
  if (tenant.leadTimezoneEnabled && lead && isValidTimeZone(lead)) return lead;
  return tenant.timezone;
}

/** Human name for a zone, for the "hora de …" suffix. */
export function zoneLabel(tz: string): string {
  return ZONE_LABEL[tz] ?? tz;
}

/**
 * The suffix printed after an hour, or '' when the lead reads the same clock as
 * the business. Compared by OFFSET at the instant in question, not by zone name:
 * a Hermosillo lead and a Tijuana calendar agree in summer and disagree in
 * winter, and only the disagreement deserves a label.
 */
export function zoneSuffix(frameTz: string, tenantTz: string, at: Date = new Date()): string {
  if (frameTz === tenantTz) return '';
  if (offsetMinutes(frameTz, at) === offsetMinutes(tenantTz, at)) return '';
  return ` hora de ${zoneLabel(frameTz)}`;
}

/** UTC offset of a zone at an instant, in minutes — via Intl, so DST is the zone's problem. */
export function offsetMinutes(tz: string, at: Date): number | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    }).formatToParts(at);
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
    const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'));
    const truncated = Math.floor(at.getTime() / 60000) * 60000;
    return Math.round((asUtc - truncated) / 60000);
  } catch {
    return null;
  }
}
