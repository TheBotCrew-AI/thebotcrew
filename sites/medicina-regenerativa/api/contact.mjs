// POST /api/contact — recibe el formulario de Contacto (ES/EN) y lo reenvía al webhook
// entrante de un workflow de GHL, que crea/actualiza el contacto en el CRM.
//
// El éxito solo se reporta cuando GHL responde 2xx: el navegador no pasa a /gracias
// si la solicitud no llegó. Sin GHL_WEBHOOK_URL configurado responde 503 y el
// formulario muestra el error general (con teléfono y WhatsApp como alternativa).
//
// Variables de entorno (Vercel → Settings → Environment Variables):
//   GHL_WEBHOOK_URL   URL del trigger "Inbound Webhook" del workflow en GHL.

const TREATMENTS = {
  general: 'Información general',
  placenta: 'Implante de placenta liofilizada',
  prolotherapy: 'Proloterapia',
  chelation: 'Quelación',
  transfer_factor: 'Factor de transferencia',
  nad: 'NAD+',
  infusion: 'Sueroterapia',
};
const LANGS = new Set(['es', 'en']);
const MAX_MESSAGE = 500;

const str = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

function validate(body) {
  const fullName = str(body.full_name, 120);
  const phoneRaw = str(body.phone, 40);
  const digits = phoneRaw.replace(/\D/g, '');
  const email = str(body.email, 160);
  const message = typeof body.contact_message === 'string' ? body.contact_message.trim() : '';

  if (fullName.length < 2) return { error: 'full_name' };
  if (/[^\d\s()+.\-]/.test(phoneRaw) || digits.length < 11 || digits.length > 15) return { error: 'phone' };
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return { error: 'email' };
  if (!Object.hasOwn(TREATMENTS, body.treatment_interest ?? '')) return { error: 'treatment_interest' };
  if (!LANGS.has(body.preferred_language)) return { error: 'preferred_language' };
  if (message.length > MAX_MESSAGE) return { error: 'contact_message' };
  if (body.contact_consent !== true) return { error: 'contact_consent' };

  const [firstName, ...rest] = fullName.split(/\s+/);
  const pageLanguage = LANGS.has(body.page_language) ? body.page_language : 'es';
  return {
    data: {
      full_name: fullName,
      first_name: firstName,
      last_name: rest.join(' '),
      phone: `+${digits}`,
      email,
      treatment_interest: body.treatment_interest,
      treatment_interest_label: TREATMENTS[body.treatment_interest],
      preferred_language: body.preferred_language,
      contact_message: message,
      contact_consent: true,
      consent_text_language: pageLanguage,
      page_language: pageLanguage,
      source_page: str(body.source_page, 200),
      source: 'sitio-web',
      submitted_at: new Date().toISOString(),
    },
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = null; }
  }
  if (!body || typeof body !== 'object') return res.status(400).json({ ok: false, error: 'bad_request' });

  // Honeypot: un humano nunca ve ni llena el campo "company". Se descarta sin reenviar.
  if (str(body.company)) return res.status(400).json({ ok: false, error: 'bad_request' });

  const { data, error } = validate(body);
  if (error) return res.status(422).json({ ok: false, error });

  const url = process.env.GHL_WEBHOOK_URL;
  if (!url) {
    console.error('contact: GHL_WEBHOOK_URL no está configurado');
    return res.status(503).json({ ok: false, error: 'not_configured' });
  }

  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
      signal: AbortSignal.timeout(9000),
    });
    if (!r.ok) {
      // Solo el status: el payload trae datos personales y no va a los logs.
      console.error(`contact: GHL respondió ${r.status}`);
      return res.status(502).json({ ok: false, error: 'upstream' });
    }
  } catch (err) {
    console.error(`contact: fallo al llamar a GHL (${err?.name ?? 'error'})`);
    return res.status(502).json({ ok: false, error: 'upstream' });
  }

  return res.status(200).json({ ok: true });
}
