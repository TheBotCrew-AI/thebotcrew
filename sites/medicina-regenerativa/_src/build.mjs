// Genera el sitio estático de Medicina Regenerativa (ES + EN) en la carpeta del sitio.
//
//   node sites/medicina-regenerativa/_src/build.mjs
//   SITE_URL=https://dominio.com node sites/medicina-regenerativa/_src/build.mjs
//
// Sin SITE_URL todo sale con noindex y sin canonical/hreflang/sitemap (borrador revisable).
// Con SITE_URL las páginas públicas se vuelven indexables. El copy vive aquí: la plantilla
// ES y la EN comparten estructura, así que una sección no puede existir en un idioma y
// faltar en el otro. Los archivos .html generados se commitean (Vercel no corre build).

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ─── Publicación ────────────────────────────────────────────────────────────────
const SITE_URL = (process.env.SITE_URL ?? 'https://medicinaregenerativatj.com').replace(/\/+$/, '');
// Fichas publicadas, en orden. 'nad' e 'infusion' tienen su copy listo abajo:
// agrégalos aquí solo cuando el cliente confirme que los ofrece.
const PUBLISHED = ['placenta', 'prolotherapy', 'chelation', 'transfer_factor'];
// El aviso de privacidad es borrador hasta que el cliente lo apruebe: noindex mientras tanto.
const PRIVACY_APPROVED = false;
// Bloque "Conoce al equipo médico" (Nosotros): oculto hasta tener credenciales confirmadas.
const SHOW_TEAM = false;
const TEAM = [
  { name: 'Dr. Cleomenes Rafael Ruiz Castillo', title: { es: '', en: '' }, license: '', photo: '' },
  { name: 'Dr. Maclovio Yañez Navarro', title: { es: '', en: '' }, license: '', photo: '' },
];
const PAGE_DATE = { es: '23 de septiembre de 2026', en: 'September 23, 2026' };
const YEAR = new Date().getFullYear();

// Fotos opcionales: si el archivo existe en img/, reemplaza la composición abstracta.
// El alt es obligatorio en ambos idiomas y debe describir la foto real.
const PHOTOS = {
  hero: { file: 'img/hero.jpg', alt: { es: '', en: '' } },
  presentacion: { file: 'img/presentacion.jpg', alt: { es: '', en: '' } },
  nosotros: { file: 'img/nosotros.jpg', alt: { es: '', en: '' } },
  banner: { file: 'img/banner.jpg', alt: { es: '', en: '' }, decorative: true },
};

// ─── Datos de contacto (plan §2.1) ──────────────────────────────────────────────
const C = {
  phoneMx: { display: '+52 664 634 6444', tel: '+526646346444' },
  phoneUs: { display: '+1 619 240 8530', tel: '+16192408530' },
  whatsapp: { display: '+52 664 728 7260', wa: '526647287260' },
  email: 'medicina.regenerativa.0101@gmail.com',
  address: {
    es: ['Plaza Thamarc, Local 1', 'Diego Rivera 2563, Zona Río', 'Tijuana, B.C., México, C.P. 22010'],
    en: ['Plaza Thamarc, Local 1', 'Diego Rivera 2563, Zona Río', 'Tijuana, B.C., Mexico, 22010'],
  },
  mapsQuery: 'Plaza Thamarc, Diego Rivera 2563, Zona Río, 22010 Tijuana, B.C., México',
  facebook: 'https://www.facebook.com/Medicina.regenerativa01/',
  instagram: 'https://www.instagram.com/medicinaregenerativa_01/',
};
const MAPS_URL = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(C.mapsQuery)}`;
const WA_TEXT = {
  es: 'Hola, me gustaría recibir información para solicitar una valoración en Medicina Regenerativa.',
  en: 'Hello, I would like information about requesting a consultation at Medicina Regenerativa.',
};
const waUrl = (text) => `https://wa.me/${C.whatsapp.wa}?text=${encodeURIComponent(text)}`;
const callPhone = (lang) => (lang === 'en' ? C.phoneUs : C.phoneMx);

// ─── Rutas (plan §5) ────────────────────────────────────────────────────────────
const ROUTES = {
  home: { es: '/', en: '/en' },
  about: { es: '/nosotros', en: '/en/about' },
  treatments: { es: '/tratamientos', en: '/en/treatments' },
  visit: { es: '/tu-consulta', en: '/en/your-visit' },
  contact: { es: '/contacto', en: '/en/contact' },
  thanks: { es: '/gracias', en: '/en/thank-you' },
  privacy: { es: '/aviso-de-privacidad', en: '/en/privacy-notice' },
};

// ─── Tratamientos (plan §9–10) ──────────────────────────────────────────────────
const TREATMENTS = {
  placenta: {
    slug: { es: 'placenta-liofilizada', en: 'freeze-dried-placenta' },
    name: { es: 'Implante de placenta liofilizada', en: 'Freeze-dried placenta implant' },
    about: { es: 'el implante de placenta liofilizada', en: 'the freeze-dried placenta implant' },
    card: {
      es: 'Consulta en qué consiste este procedimiento, qué producto se utiliza y qué información debes conocer antes de considerarlo.',
      en: 'Ask what the procedure involves, which product is used, and what information you should review before considering it.',
    },
    intro: {
      es: 'Si deseas conocer el implante de placenta liofilizada, solicita información sobre el producto específico, su procedencia, la forma de aplicación y las consideraciones médicas antes de tomar una decisión.',
      en: 'If you would like to learn about a freeze-dried placenta implant, ask about the specific product, its source, the administration method, and the medical considerations before making a decision.',
    },
    questions: {
      es: [
        '¿Qué producto se utiliza y qué documentación lo respalda?',
        '¿Qué evidencia existe para el uso que se propone en mi caso?',
        '¿Cuáles son los riesgos, las alternativas y el seguimiento previsto?',
      ],
      en: [
        'Which product is used, and what documentation supports it?',
        'What evidence is available for the use being proposed in my case?',
        'What are the risks, alternatives, and planned follow-up?',
      ],
    },
  },
  prolotherapy: {
    slug: { es: 'proloterapia', en: 'prolotherapy' },
    name: { es: 'Proloterapia', en: 'Prolotherapy' },
    about: { es: 'la proloterapia', en: 'prolotherapy' },
    card: {
      es: 'Solicita una valoración para conversar sobre la proloterapia y su pertinencia en tu caso.',
      en: 'Request a consultation to discuss prolotherapy and whether it may be relevant to your circumstances.',
    },
    intro: {
      es: 'Si estás considerando la proloterapia, solicita una valoración para conversar sobre el motivo de tu consulta, la técnica propuesta y las opciones disponibles para tu caso.',
      en: 'If you are considering prolotherapy, request a consultation to discuss the reason for your visit, the proposed technique, and the options available for your circumstances.',
    },
    questions: {
      es: [
        '¿Qué técnica y sustancias se utilizarían?',
        '¿Por qué se consideraría esta opción en mi caso y qué alternativas existen?',
        '¿Qué molestias, riesgos, cuidados y número de sesiones debo considerar?',
      ],
      en: [
        'Which technique and substances would be used?',
        'Why would this option be considered for my circumstances, and what alternatives are available?',
        'What discomfort, risks, aftercare, and number of sessions should I consider?',
      ],
    },
  },
  chelation: {
    slug: { es: 'quelacion', en: 'chelation' },
    name: { es: 'Quelación', en: 'Chelation therapy' },
    about: { es: 'la quelación', en: 'chelation therapy' },
    card: {
      es: 'Conoce las indicaciones, precauciones y evaluación previa de esta terapia.',
      en: 'Ask about the indications, precautions, and assessment required before considering this therapy.',
    },
    intro: {
      es: 'Antes de considerar la quelación, solicita información sobre la indicación concreta, el producto utilizado y la evaluación necesaria. Pregunta qué beneficios y riesgos corresponden a tu situación.',
      en: 'Before considering chelation therapy, ask about the specific indication, the product used, and the required assessment. Discuss the potential benefits and risks relevant to your circumstances.',
    },
    questions: {
      es: [
        '¿Cuál es la indicación específica para proponerla en mi caso?',
        '¿Qué evaluación y estudios se requieren antes de considerarla?',
        '¿Qué producto se utiliza, cuáles son sus riesgos y cómo se realiza el seguimiento?',
      ],
      en: [
        'What is the specific indication for proposing it in my case?',
        'What assessment and tests are required before considering it?',
        'Which product is used, what are its risks, and how is follow-up managed?',
      ],
    },
  },
  transfer_factor: {
    slug: { es: 'factor-de-transferencia', en: 'transfer-factor' },
    name: { es: 'Factor de transferencia', en: 'Transfer factor' },
    about: { es: 'el factor de transferencia', en: 'transfer factor' },
    card: {
      es: 'Solicita información sobre el producto, su uso y las consideraciones médicas correspondientes.',
      en: 'Request information about the product, its use, and the relevant medical considerations.',
    },
    intro: {
      es: 'Solicita información sobre el producto de factor de transferencia que se ofrece, su composición y el uso propuesto. Conversa con el médico sobre la evidencia y las consideraciones relevantes para tu caso.',
      en: 'Ask about the transfer factor product being offered, its composition, and its proposed use. Discuss the evidence and the considerations relevant to your circumstances with a physician.',
    },
    questions: {
      es: [
        '¿Cuál es el producto y qué contiene?',
        '¿Qué evidencia respalda el uso que se propone?',
        '¿Qué riesgos, interacciones y alternativas debo conocer?',
      ],
      en: [
        'Which product is offered, and what does it contain?',
        'What evidence supports the proposed use?',
        'What risks, interactions, and alternatives should I understand?',
      ],
    },
  },
  nad: {
    slug: { es: 'nad', en: 'nad' },
    name: { es: 'NAD+', en: 'NAD+' },
    about: { es: 'NAD+', en: 'NAD+' },
    card: {
      es: 'Consulta disponibilidad e información sobre las opciones con NAD+ y su evaluación previa.',
      en: 'Ask about the availability of NAD+ options and the assessment required before considering them.',
    },
    intro: {
      es: 'Consulta si Medicina Regenerativa ofrece actualmente opciones con NAD+ y solicita información sobre el producto, la modalidad de uso y la evaluación previa correspondiente.',
      en: 'Ask whether Medicina Regenerativa currently offers NAD+ options and request information about the product, method of use, and relevant preliminary assessment.',
    },
    questions: {
      es: [
        '¿Qué producto y modalidad están disponibles?',
        '¿Cuál es el objetivo del uso propuesto y qué evidencia lo respalda?',
        '¿Qué riesgos, precauciones y costos debo conocer?',
      ],
      en: [
        'Which product and method are available?',
        'What is the purpose of the proposed use, and what evidence supports it?',
        'What risks, precautions, and costs should I understand?',
      ],
    },
  },
  infusion: {
    slug: { es: 'sueroterapia', en: 'infusion-therapy' },
    name: { es: 'Sueroterapia', en: 'Infusion therapy' },
    about: { es: 'la sueroterapia', en: 'infusion therapy' },
    card: {
      es: 'Consulta las opciones disponibles y la valoración necesaria antes de su aplicación.',
      en: 'Ask about the available options and the assessment required before administration.',
    },
    intro: {
      es: 'Consulta qué opciones de sueroterapia están disponibles y qué contienen. Antes de considerar su aplicación, solicita información sobre la valoración requerida y su pertinencia en tu caso.',
      en: 'Ask which infusion therapy options are available and what they contain. Before considering administration, request information about the required assessment and suitability for your circumstances.',
    },
    questions: {
      es: [
        '¿Qué sustancias contiene la opción que se propone?',
        '¿Por qué se consideraría su aplicación en mi caso?',
        '¿Qué riesgos, interacciones y seguimiento debo conocer?',
      ],
      en: [
        'Which substances are included in the proposed option?',
        'Why would it be considered for my circumstances?',
        'What risks, interactions, and follow-up should I understand?',
      ],
    },
  },
};

// Datos operativos de los trípticos y PDFs del cliente (sep 2026): cómo se aplica, esquema,
// requisitos y producto. Las listas de padecimientos y las promesas de resultados de esos
// materiales NO se publican (plan §1 y §2.2): son afirmaciones sanitarias sin respaldo.
const FACTS = {
  placenta: [
    {
      icon: 'layers',
      h: { es: 'Qué es', en: 'What it is' },
      p: {
        es: 'Un biológico elaborado a partir de placenta que se liofiliza —se deshidrata en frío— para conservarlo. Su procesamiento sigue la técnica descrita por el Dr. Vladimir Filatov, que somete el tejido a cambios bruscos de temperatura.',
        en: 'A biological product made from placenta that is freeze-dried to preserve it. It is processed following the technique described by Dr. Vladimir Filatov, which exposes the tissue to sudden temperature changes.',
      },
    },
    {
      icon: 'target',
      h: { es: 'Cómo se aplica', en: 'How it is administered' },
      p: {
        es: 'Antes de aplicarlo, el implante se rehidrata. Se coloca de forma subdérmica, por lo general en el tejido adiposo alrededor del ombligo, donde se absorbe poco a poco.',
        en: 'The implant is rehydrated before use. It is placed under the skin, usually in the fatty tissue around the navel, where it is gradually absorbed.',
      },
    },
    {
      icon: 'document',
      h: { es: 'Producto', en: 'Product' },
      p: {
        es: 'La clínica trabaja con placenta liofilizada de la marca CDC, en presentación de 1 g.',
        en: 'The clinic uses freeze-dried placenta from the CDC brand, supplied in 1 g vials.',
      },
    },
    {
      icon: 'repeat',
      h: { es: 'Complemento de otras terapias', en: 'Alongside other care' },
      p: {
        es: 'El médico puede recomendar otras terapias para complementar el tratamiento. No sustituye los tratamientos indicados por tu médico tratante.',
        en: 'The physician may recommend other therapies alongside it. It does not replace treatments prescribed by your own physician.',
      },
    },
  ],
  prolotherapy: [
    {
      icon: 'target',
      h: { es: 'Cómo se aplica', en: 'How it is administered' },
      p: {
        es: 'Mediante inyecciones en la zona tratada, como articulaciones, ligamentos o tendones.',
        en: 'Through injections in the area being treated, such as joints, ligaments, or tendons.',
      },
    },
    {
      icon: 'calendar',
      h: { es: 'Sesiones', en: 'Sessions' },
      p: {
        es: 'El número de sesiones varía en cada paciente. El tiempo entre sesiones es de aproximadamente 6 semanas, según el diagnóstico del médico.',
        en: 'The number of sessions varies for each patient. Sessions are usually about 6 weeks apart, depending on the physician’s diagnosis.',
      },
    },
    {
      icon: 'info',
      h: { es: 'Después de la aplicación', en: 'After each session' },
      p: {
        es: 'Durante los 2 o 3 días posteriores es habitual sentir inflamación e irritación en la zona tratada.',
        en: 'Swelling and irritation in the treated area are common for 2 to 3 days afterward.',
      },
    },
    {
      icon: 'user',
      h: { es: 'Riesgos', en: 'Risks' },
      p: {
        es: 'Los posibles riesgos o efectos dependen del área tratada y se revisan con el médico en la consulta previa.',
        en: 'Possible risks and side effects depend on the area treated and are reviewed with the physician at the initial consultation.',
      },
    },
  ],
  chelation: [
    {
      icon: 'target',
      h: { es: 'Cómo se aplica', en: 'How it is administered' },
      p: {
        es: 'Mediante soluciones endovenosas, es decir, aplicadas por vena.',
        en: 'Through intravenous solutions, given into a vein.',
      },
    },
    {
      icon: 'calendar',
      h: { es: 'Esquema de referencia', en: 'Typical schedule' },
      p: {
        es: 'Entre 10 y 15 aplicaciones, de forma semanal o bisemanal. El médico define el esquema de cada paciente.',
        en: 'Between 10 and 15 sessions, given weekly or twice a week. The physician sets each patient’s schedule.',
      },
    },
    {
      icon: 'clipboard',
      h: { es: 'Antes de iniciar', en: 'Before starting' },
      p: {
        es: 'Está dirigida a personas mayores de 20 años. Todos los pacientes se realizan un estudio clínico y de laboratorio antes de comenzar.',
        en: 'It is intended for people over 20 years of age. Every patient has a clinical assessment and laboratory tests before starting.',
      },
    },
    {
      icon: 'info',
      h: { es: 'Contraindicaciones', en: 'Contraindications' },
      p: {
        es: 'No se aplica en personas con alergia al medicamento ni con daño renal irreversible. El médico revisa tu caso antes de indicarla.',
        en: 'It is not given to people who are allergic to the medication or who have irreversible kidney damage. The physician reviews your case before recommending it.',
      },
    },
  ],
  transfer_factor: [
    {
      icon: 'document',
      h: { es: 'Producto', en: 'Product' },
      p: {
        es: 'La clínica trabaja con Inmunizel, un factor de transferencia de la marca DK Zell.',
        en: 'The clinic uses Inmunizel, a transfer factor product from the DK Zell brand.',
      },
    },
    {
      icon: 'layers',
      h: { es: 'Enfoque', en: 'Focus' },
      p: {
        es: 'Se ofrece como terapia de apoyo relacionada con el sistema inmunológico. El médico valora si es pertinente en tu caso.',
        en: 'It is offered as a supportive therapy related to the immune system. The physician assesses whether it is appropriate for you.',
      },
    },
    {
      icon: 'repeat',
      h: { es: 'Junto con otros tratamientos', en: 'Alongside other treatment' },
      p: {
        es: 'Se utiliza como complemento: no sustituye los tratamientos indicados por tu médico tratante. Informa al médico de los medicamentos que tomas.',
        en: 'It is used as a complement and does not replace treatments prescribed by your own physician. Tell the physician about any medications you take.',
      },
    },
  ],
};

for (const code of PUBLISHED) {
  if (!TREATMENTS[code]) throw new Error(`PUBLISHED incluye un tratamiento desconocido: ${code}`);
  ROUTES[`t_${code}`] = {
    es: `/tratamientos/${TREATMENTS[code].slug.es}`,
    en: `/en/treatments/${TREATMENTS[code].slug.en}`,
  };
}

// ─── Utilidades ─────────────────────────────────────────────────────────────────
const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const t = (lang, pair) => pair[lang];
const url = (key, lang) => ROUTES[key][lang];
const other = (lang) => (lang === 'es' ? 'en' : 'es');

function assetVersion(file) {
  return createHash('sha1').update(readFileSync(join(ROOT, file))).digest('hex').slice(0, 10);
}
const V_CSS = assetVersion('assets/site.css');
const V_JS = assetVersion('assets/site.js');

function photo(key) {
  const p = PHOTOS[key];
  if (!existsSync(join(ROOT, p.file))) return null;
  if (!p.decorative && (!p.alt.es || !p.alt.en)) {
    throw new Error(`${p.file} existe pero le falta el texto alternativo ES/EN en PHOTOS.${key}.alt`);
  }
  return p;
}
const img = (p, lang, attrs = '') =>
  `<img src="/${p.file}" alt="${p.decorative ? '' : esc(p.alt[lang])}" ${attrs}>`;

// ─── Iconos (trazo 2px, 24×24) ──────────────────────────────────────────────────
const ICONS = {
  phone: '<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z"/>',
  chat: '<path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5z"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  document: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M16 13H8M16 17H8M10 9H8"/>',
  pin: '<path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>',
  mail: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 6-10 7L2 6"/>',
  arrow: '<path d="M5 12h14M12 5l7 7-7 7"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  clipboard: '<path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/><rect x="9" y="3" width="6" height="4" rx="1"/><path d="M9 12h6M9 16h4"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
  layers: '<path d="m12 2 10 5-10 5L2 7z"/><path d="m2 17 10 5 10-5M2 12l10 5 10-5"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01"/>',
  eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  repeat: '<path d="m17 2 4 4-4 4"/><path d="M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4"/><path d="M21 13v2a3 3 0 0 1-3 3H3"/>',
  compass: '<circle cx="12" cy="12" r="9"/><path d="m16 8-2 6-6 2 2-6z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
  map: '<path d="m1 6 7-3 8 3 7-3v15l-7 3-8-3-7 3z"/><path d="M8 3v15M16 6v15"/>',
  menu: '<path d="M3 6h18M3 12h18M3 18h18"/>',
  close: '<path d="M18 6 6 18M6 6l12 12"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  instagram: '<rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><path d="M17.5 6.5h.01"/>',
  facebook: '<path d="M18 2h-3a5 5 0 0 0-5 5v3H7v4h3v8h4v-8h3l1-4h-4V7a1 1 0 0 1 1-1h3z"/>',
};
const icon = (name, cls = '') =>
  `<svg${cls ? ` class="${cls}"` : ''} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICONS[name]}</svg>`;

// ─── Composiciones abstractas (motivo de doble hélice, eco del logo MR) ─────────
const f1 = (n) => Math.round(n * 10) / 10;
function helix({ cx, cy, length, amp, period, vertical, phase = 0, stroke, rungStroke, width = 2 }) {
  const a = [];
  const b = [];
  const rungs = [];
  for (let s = 0; s <= length; s += 6) {
    const w = Math.sin((s / period) * Math.PI * 2 + phase) * amp;
    const along = (vertical ? cy : cx) - length / 2 + s;
    const p1 = vertical ? [cx + w, along] : [along, cy + w];
    const p2 = vertical ? [cx - w, along] : [along, cy - w];
    a.push(p1);
    b.push(p2);
    if (s % 24 === 0 && Math.abs(w) > amp * 0.25) {
      rungs.push(`M${f1(p1[0])} ${f1(p1[1])}L${f1(p2[0])} ${f1(p2[1])}`);
    }
  }
  const d = (pts) => 'M' + pts.map((p) => `${f1(p[0])} ${f1(p[1])}`).join('L');
  return (
    `<path d="${rungs.join('')}" stroke="${rungStroke}" stroke-width="1.5" stroke-linecap="round" fill="none"/>` +
    `<path d="${d(a)}" stroke="${stroke}" stroke-width="${width}" fill="none" stroke-linecap="round"/>` +
    `<path d="${d(b)}" stroke="${stroke}" stroke-width="${width}" fill="none" stroke-linecap="round" opacity=".7"/>`
  );
}

const heroArt = () =>
  `<svg viewBox="0 0 500 520" preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false">
    <circle cx="400" cy="90" r="170" fill="#fff" opacity=".38"/>
    <circle cx="70" cy="470" r="150" fill="#8AC6D2" opacity=".28"/>
    <circle cx="250" cy="260" r="130" fill="none" stroke="#fff" stroke-width="1.5" opacity=".7"/>
    <circle cx="250" cy="260" r="185" fill="none" stroke="#fff" stroke-width="1.2" opacity=".5"/>
    <circle cx="250" cy="260" r="240" fill="none" stroke="#fff" stroke-width="1" opacity=".35"/>
    ${helix({ cx: 250, cy: 260, length: 600, amp: 64, period: 230, vertical: true, stroke: '#087F8C', rungStroke: 'rgba(18,58,86,.28)', width: 3 })}
    <circle cx="250" cy="260" r="7" fill="#123A56"/>
  </svg>`;

const linesArt = (opacity = 1, cy = 300) =>
  `<svg viewBox="0 0 1200 420" preserveAspectRatio="xMidYMax slice" aria-hidden="true" focusable="false" style="opacity:${opacity}">
    <circle cx="1080" cy="60" r="220" fill="none" stroke="rgba(138,211,218,.35)" stroke-width="1.2"/>
    <circle cx="1080" cy="60" r="300" fill="none" stroke="rgba(138,211,218,.22)" stroke-width="1"/>
    <circle cx="120" cy="420" r="180" fill="none" stroke="rgba(138,211,218,.22)" stroke-width="1"/>
    ${helix({ cx: 600, cy, length: 1320, amp: 38, period: 420, vertical: false, stroke: 'rgba(138,211,218,.55)', rungStroke: 'rgba(138,211,218,.22)', width: 1.6 })}
  </svg>`;

// Cada tarjeta de tratamiento lleva la misma hélice con otra fase: familia visual, sin
// iconos que sugieran una indicación o un resultado.
const TCARD_VARIANT = { placenta: 0, prolotherapy: 1.2, chelation: 2.4, transfer_factor: 3.6, nad: 4.8, infusion: 6 };
const tcardArt = (code) => {
  const ph = TCARD_VARIANT[code] ?? 0;
  const cx = 60 + ((ph * 57) % 260);
  return `<svg viewBox="0 0 400 132" preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false">
    <circle cx="${f1(cx + 60)}" cy="20" r="80" fill="#fff" opacity=".4"/>
    <circle cx="${f1(360 - cx / 2)}" cy="140" r="60" fill="#8AC6D2" opacity=".25"/>
    ${helix({ cx: 200, cy: 66, length: 460, amp: 26, period: 170, phase: ph, vertical: false, stroke: '#087F8C', rungStroke: 'rgba(18,58,86,.22)', width: 2.4 })}
  </svg>`;
};

const locationArt = () =>
  `<svg viewBox="0 0 480 300" preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false">
    <rect width="480" height="300" fill="#E4F1F4"/>
    <circle cx="240" cy="150" r="60" fill="none" stroke="#9CCBD5" stroke-width="1.5"/>
    <circle cx="240" cy="150" r="105" fill="none" stroke="#B5D9E0" stroke-width="1.2"/>
    <circle cx="240" cy="150" r="150" fill="none" stroke="#CBE4E9" stroke-width="1"/>
    <circle cx="240" cy="150" r="200" fill="none" stroke="#D7EBEF" stroke-width="1"/>
    <g transform="translate(212 104)" stroke="#fff" stroke-width="3" fill="#087F8C">
      <path d="M28 0C12.5 0 0 12.2 0 27.4 0 48 28 70 28 70s28-22 28-42.6C56 12.2 43.5 0 28 0z"/>
      <circle cx="28" cy="27" r="9" fill="#fff" stroke="none"/>
    </g>
  </svg>`;

// ─── Componentes ────────────────────────────────────────────────────────────────
const NAV = [
  ['home', { es: 'Inicio', en: 'Home' }],
  ['about', { es: 'Nosotros', en: 'About us' }],
  ['treatments', { es: 'Tratamientos', en: 'Treatments' }],
  ['visit', { es: 'Tu consulta', en: 'Your visit' }],
  ['contact', { es: 'Contacto', en: 'Contact' }],
];
const L = {
  cta: { es: 'Solicitar valoración', en: 'Request a consultation' },
  call: { es: 'Llamar', en: 'Call us' },
  openMenu: { es: 'Abrir menú', en: 'Open menu' },
  closeMenu: { es: 'Cerrar menú', en: 'Close menu' },
  mainNav: { es: 'Principal', en: 'Main' },
  langNav: { es: 'Idioma', en: 'Language' },
  skip: { es: 'Saltar al contenido', en: 'Skip to content' },
  whatsapp: { es: 'Escribir por WhatsApp', en: 'Message us on WhatsApp' },
  place: { es: 'Tijuana, B.C.', en: 'Tijuana, B.C.' },
  breadcrumb: { es: 'Ruta de navegación', en: 'Breadcrumb' },
};

function brand(lang) {
  return `<a class="brand" href="${url('home', lang)}">
      <span class="brand__mark" aria-hidden="true">MR</span>
      <span class="brand__name">Medicina Regenerativa<small>${t(lang, L.place)}</small></span>
    </a>`;
}

function langSwitch(lang, pairPath) {
  const es = lang === 'es'
    ? '<span aria-current="true" lang="es">Español</span>'
    : `<a href="${pairPath}" lang="es" hreflang="es">Español</a>`;
  const en = lang === 'en'
    ? '<span aria-current="true" lang="en">English</span>'
    : `<a href="${pairPath}" lang="en" hreflang="en">English</a>`;
  return `<div class="lang" role="group" aria-label="${t(lang, L.langNav)}">${es}<span class="lang__sep" aria-hidden="true">/</span>${en}</div>`;
}

function header(lang, key, pairPath) {
  const phone = callPhone(lang);
  const links = NAV.map(([k, label]) =>
    `<li><a href="${url(k, lang)}"${k === key ? ' aria-current="page"' : ''}>${t(lang, label)}</a></li>`).join('');
  return `<header class="site-header">
  <div class="container site-header__in">
    ${brand(lang)}
    <nav class="nav" aria-label="${t(lang, L.mainNav)}"><ul class="nav__list">${links}</ul></nav>
    <div class="header-actions">
      ${langSwitch(lang, pairPath)}
      <a class="btn btn--secondary header-call" href="tel:${phone.tel}" aria-label="${t(lang, L.call)}: ${phone.display}">${icon('phone')}<span>${t(lang, L.call)}</span></a>
      <a class="btn btn--primary header-cta" href="${url('contact', lang)}#formulario">${t(lang, L.cta)}</a>
    </div>
    <button class="menu-toggle" type="button" aria-expanded="false" aria-controls="mobile-menu" aria-label="${t(lang, L.openMenu)}" data-label-open="${t(lang, L.openMenu)}" data-label-close="${t(lang, L.closeMenu)}">${icon('menu', 'icon-open')}${icon('close', 'icon-close')}</button>
  </div>
</header>
<div class="mobile-menu" id="mobile-menu" hidden>
  <nav aria-label="${t(lang, L.mainNav)}"><ul class="mobile-menu__list">${links}</ul></nav>
  <div class="mobile-menu__actions">
    <a class="btn btn--primary" href="${url('contact', lang)}#formulario">${t(lang, L.cta)}</a>
    <a class="btn btn--secondary" href="tel:${phone.tel}">${icon('phone')}<span>${t(lang, L.call)} · ${phone.display}</span></a>
    <a class="btn btn--secondary" href="${waUrl(WA_TEXT[lang])}" target="_blank" rel="noopener">${icon('chat')}<span>${t(lang, L.whatsapp)}</span></a>
  </div>
  ${langSwitch(lang, pairPath)}
</div>`;
}

const CTA_COPY = {
  es: {
    title: 'Da el primer paso: solicita una valoración',
    text: 'Contáctanos para consultar disponibilidad, conocer el costo de la consulta y resolver tus dudas antes de tu visita.',
  },
  en: {
    title: 'Take the first step: request a consultation',
    text: 'Contact us to check availability, ask about consultation fees, and get answers before your visit.',
  },
};
function ctaBand(lang) {
  const c = CTA_COPY[lang];
  return `<section class="cta" aria-labelledby="cta-title">
  <div class="cta__lines">${linesArt()}</div>
  <div class="container"><div class="cta__in">
    <h2 id="cta-title">${c.title}</h2>
    <p>${c.text}</p>
    <div class="btn-row">
      <a class="btn btn--light" href="${url('contact', lang)}#formulario">${t(lang, L.cta)}</a>
      <a class="btn btn--ghost-light" href="${waUrl(WA_TEXT[lang])}" target="_blank" rel="noopener">${icon('chat')}${t(lang, L.whatsapp)}</a>
    </div>
  </div></div>
</section>`;
}

const FOOTER_COPY = {
  es: {
    desc: 'Información sobre Medicina Regenerativa y sus tratamientos en Tijuana. Contáctanos para solicitar una valoración médica.',
    explore: 'Explora',
    contact: 'Contacto',
    phoneMx: 'Teléfono México',
    phoneUs: 'Teléfono EE. UU.',
    email: 'Correo electrónico',
    address: 'Dirección',
    privacy: 'Aviso de privacidad',
    note: 'La información de este sitio es de carácter general y no sustituye una valoración médica. Las indicaciones, riesgos y resultados dependen del tratamiento y de cada caso.',
    copy: `© ${YEAR} Medicina Regenerativa. Todos los derechos reservados.`,
  },
  en: {
    desc: 'Information about Medicina Regenerativa and its treatments in Tijuana. Contact us to request a medical consultation.',
    explore: 'Explore',
    contact: 'Contact',
    phoneMx: 'Mexico phone',
    phoneUs: 'U.S. phone',
    email: 'Email',
    address: 'Address',
    privacy: 'Privacy notice',
    note: 'The information on this website is general and does not replace a medical consultation. Indications, risks, and results depend on the treatment and individual circumstances.',
    copy: `© ${YEAR} Medicina Regenerativa. All rights reserved.`,
  },
};
function footer(lang) {
  const f = FOOTER_COPY[lang];
  const links = NAV.map(([k, label]) => `<li><a href="${url(k, lang)}">${t(lang, label)}</a></li>`).join('');
  return `<footer class="site-footer">
  <div class="container">
    <div class="footer__grid">
      <div class="footer__brand">
        ${brand(lang)}
        <p>${f.desc}</p>
        <div class="footer__social">
          <a href="${C.facebook}" target="_blank" rel="noopener" aria-label="Facebook">${icon('facebook')}</a>
          <a href="${C.instagram}" target="_blank" rel="noopener" aria-label="Instagram">${icon('instagram')}</a>
        </div>
      </div>
      <div>
        <h2 class="footer__h">${f.explore}</h2>
        <ul class="footer__links">${links}</ul>
      </div>
      <div>
        <h2 class="footer__h">${f.contact}</h2>
        <ul class="footer__contact">
          <li>${icon('phone')}<span><small>${f.phoneMx}</small><a href="tel:${C.phoneMx.tel}">${C.phoneMx.display}</a></span></li>
          <li>${icon('phone')}<span><small>${f.phoneUs}</small><a href="tel:${C.phoneUs.tel}">${C.phoneUs.display}</a></span></li>
          <li>${icon('chat')}<span><small>WhatsApp</small><a href="${waUrl(WA_TEXT[lang])}" target="_blank" rel="noopener">${C.whatsapp.display}</a></span></li>
          <li>${icon('mail')}<span><small>${f.email}</small><a href="mailto:${C.email}">${C.email}</a></span></li>
          <li>${icon('pin')}<span><small>${f.address}</small><a href="${MAPS_URL}" target="_blank" rel="noopener">${C.address[lang].join(', ')}</a></span></li>
        </ul>
      </div>
    </div>
    <div class="footer__bottom">
      <p class="footer__note">${f.note}</p>
      <div class="footer__legal"><span>${f.copy}</span><a href="${url('privacy', lang)}">${f.privacy}</a></div>
    </div>
  </div>
</footer>`;
}

function banner(lang, { title, text = '', crumbs = null }) {
  const p = photo('banner');
  const bg = p
    ? `<div class="banner__bg banner__bg--photo">${img(p, lang)}</div>`
    : `<div class="banner__bg">${linesArt(0.6, 395)}</div>`;
  const bc = crumbs
    ? `<nav class="breadcrumb" aria-label="${t(lang, L.breadcrumb)}"><ol>${crumbs
        .map(([label, href]) => (href ? `<li><a href="${href}">${label}</a></li>` : `<li aria-current="page">${label}</li>`))
        .join('')}</ol></nav>`
    : '';
  return `<section class="banner">
  ${bg}
  <div class="container"><div class="banner__in">
    ${bc}
    <h1>${title}</h1>
    ${text ? `<p>${text}</p>` : ''}
  </div></div>
</section>`;
}

function treatmentCard(lang, code) {
  const tr = TREATMENTS[code];
  return `<article class="card tcard">
      <div class="tcard__art">${tcardArt(code)}</div>
      <div class="tcard__body">
        <h3>${tr.name[lang]}</h3>
        <p>${tr.card[lang]}</p>
        <a class="btn btn--secondary" href="${url(`t_${code}`, lang)}" aria-label="${lang === 'es' ? 'Conocer el tratamiento' : 'Learn about this treatment'}: ${tr.name[lang]}">${lang === 'es' ? 'Conocer el tratamiento' : 'Learn about this treatment'}${icon('arrow')}</a>
      </div>
    </article>`;
}
const gridFor = (n) => (n === 4 || n === 2 ? 'grid--2' : n === 1 ? '' : 'grid--3');

// ─── Páginas ────────────────────────────────────────────────────────────────────
function homeBody(lang) {
  const es = lang === 'es';
  const heroPhoto = photo('hero');
  const presPhoto = photo('presentacion');
  const featured = ['placenta', 'prolotherapy', 'chelation'].filter((c) => PUBLISHED.includes(c));
  const faqs = es
    ? [
        ['¿Cómo puedo saber si un tratamiento es adecuado para mí?', 'Solicita una valoración médica para revisar tu caso y conversar sobre las opciones disponibles.'],
        ['¿Cuántas sesiones necesitaría?', 'No hay un número único para todos los pacientes. Solicita información sobre el esquema que correspondería a tu caso.'],
        ['¿Cuándo podría observar resultados?', 'Los resultados y sus tiempos pueden variar. Antes de iniciar, consulta qué expectativas son razonables para el tratamiento y tu situación.'],
        ['¿Cómo solicito una cita y conozco el costo?', 'Comunícate por teléfono, WhatsApp o mediante el formulario para consultar disponibilidad y costo de la valoración.'],
      ]
    : [
        ['How can I find out whether a treatment is suitable for me?', 'Request a medical consultation to discuss your circumstances and the available options.'],
        ['How many sessions would I need?', 'There is no single number of sessions for every patient. Ask about the approach that may be appropriate for your circumstances.'],
        ['When could I expect to see results?', 'Results and timelines can vary. Before starting, ask what expectations are reasonable for the treatment and your individual situation.'],
        ['How do I request an appointment and find out the cost?', 'Contact us by phone, WhatsApp, or the contact form to ask about availability and consultation fees.'],
      ];
  const steps = es
    ? [
        ['chat', 'Cuéntanos qué te interesa.', 'Indica el motivo de tu consulta o el tratamiento sobre el que deseas información.'],
        ['document', 'Prepara tus preguntas.', 'Anota tus dudas sobre el procedimiento, sus riesgos, las alternativas y el costo.'],
        ['calendar', 'Solicita una valoración.', 'Contacta al equipo para consultar disponibilidad y organizar tu visita.'],
      ]
    : [
        ['chat', 'Tell us what interests you.', 'Share the reason for your visit or the treatment you would like to learn about.'],
        ['document', 'Prepare your questions.', 'Write down what you want to ask about the procedure, risks, alternatives, and cost.'],
        ['calendar', 'Request a consultation.', 'Contact the team to check availability and arrange your visit.'],
      ];
  const qnoteItems = es
    ? ['El procedimiento', 'Los riesgos', 'Las alternativas', 'El costo']
    : ['The procedure', 'The risks', 'The alternatives', 'The cost'];

  const heroVisual = heroPhoto
    ? `<div class="hero-visual"><div class="hero-visual__panel">${img(heroPhoto, lang, 'width="1000" height="1040" fetchpriority="high"')}</div></div>`
    : `<div class="hero-visual">
        <div class="hero-visual__panel">${heroArt()}</div>
        <div class="hero-chip hero-chip--b"><span class="hero-chip__icon">${icon('calendar')}</span><span><strong>${es ? 'Valoración médica' : 'Medical consultation'}</strong><span>${es ? 'El primer paso' : 'The first step'}</span></span></div>
        <div class="hero-chip hero-chip--a"><span class="hero-chip__icon">${icon('pin')}</span><span><strong>Zona Río, Tijuana</strong><span>Baja California</span></span></div>
      </div>`;

  const presVisual = presPhoto
    ? `<div class="photo-frame">${img(presPhoto, lang, 'loading="lazy"')}</div>`
    : `<div class="qnote" aria-hidden="true">
        <div class="qnote__lines">${linesArt()}</div>
        <div class="qnote__card">
          <p class="qnote__title">${icon('clipboard')}${es ? 'Mis preguntas para la consulta' : 'My questions for the visit'}</p>
          <ul>${qnoteItems.map((q, i) => `<li${i === 0 ? ' class="is-done"' : ''}><span class="qnote__box">${i === 0 ? icon('check') : ''}</span>${q}</li>`).join('')}</ul>
        </div>
      </div>`;

  return `
<section class="hero">
  <div class="container hero__grid">
    <div class="hero__text">
      <span class="eyebrow">Medicina Regenerativa · Tijuana</span>
      <h1>${es ? 'Conoce tus opciones. Empieza con una valoración médica.' : 'Explore your options. Start with a medical consultation.'}</h1>
      <p class="lead">${es
        ? 'Infórmate sobre nuestros tratamientos y conversa con el equipo sobre tus necesidades, tus dudas y los siguientes pasos para tu consulta.'
        : 'Learn about our treatments and contact the team to discuss your needs, your questions, and the next steps for your visit.'}</p>
      <div class="btn-row">
        <a class="btn btn--primary" href="${url('contact', lang)}#formulario">${t(lang, L.cta)}</a>
        <a class="btn btn--secondary" href="${url('treatments', lang)}">${es ? 'Explorar tratamientos' : 'Explore treatments'}</a>
      </div>
      <p class="hero__place">${icon('pin')}${es ? 'Tijuana, Baja California, México' : 'Tijuana, Baja California, Mexico'}</p>
    </div>
    ${heroVisual}
  </div>
</section>

<section class="section">
  <div class="container split">
    ${presVisual}
    <div class="split__text">
      <span class="eyebrow">${es ? 'Antes de decidir' : 'Before you decide'}</span>
      <h2>${es ? 'Una valoración es el primer paso' : 'Start with a consultation'}</h2>
      <p>${es
        ? 'Cada persona llega con preguntas y necesidades distintas. Si estás considerando un tratamiento, solicita una consulta para revisar tu caso y preguntar por sus indicaciones, riesgos y alternativas.'
        : 'Everyone has different questions and needs. If you are considering a treatment, request a consultation to discuss your circumstances and ask about its indications, risks, and alternatives.'}</p>
      <a class="link-arrow" href="${url('visit', lang)}">${es ? 'Cómo preparar tu consulta' : 'Prepare for your visit'}${icon('arrow')}</a>
    </div>
  </div>
</section>

<section class="section section--alt" aria-labelledby="steps-title">
  <div class="container">
    <h2 id="steps-title" class="sr-only">${es ? 'Cómo empezar' : 'How to start'}</h2>
    <ol class="grid grid--3">
      ${steps.map(([ic, title, text], i) => `<li class="card">
        <div class="card__icon">${icon(ic)}</div>
        <h3><span class="sr-only">${es ? 'Paso' : 'Step'} ${i + 1}: </span>${title}</h3>
        <p>${text}</p>
      </li>`).join('')}
    </ol>
  </div>
</section>

${featured.length ? `<section class="section">
  <div class="container">
    <div class="section-head center">
      <h2>${es ? 'Información sobre nuestros tratamientos' : 'Learn about our treatments'}</h2>
      <p>${es
        ? 'Conoce las opciones presentadas por Medicina Regenerativa y solicita información antes de considerar un procedimiento.'
        : 'Explore the options presented by Medicina Regenerativa and request information before considering a procedure.'}</p>
    </div>
    <div class="grid ${gridFor(featured.length)}">${featured.map((c) => treatmentCard(lang, c)).join('')}</div>
    <div class="grid-foot"><a class="link-arrow" href="${url('treatments', lang)}">${es ? 'Ver todos los tratamientos' : 'View all treatments'}${icon('arrow')}</a></div>
  </div>
</section>` : ''}

<section class="section--tight section">
  <div class="container">
    <div class="band">
      <div class="band__icon">${icon('chat')}</div>
      <div class="band__text">
        <h2>${es ? '¿Tienes dudas sobre un tratamiento?' : 'Have questions about a treatment?'}</h2>
        <p>${es ? 'Solicita información sobre su aplicación, riesgos, alternativas y seguimiento.' : 'Ask about the procedure, risks, alternatives, and follow-up.'}</p>
      </div>
      <a class="btn btn--light" href="${url('contact', lang)}#formulario">${es ? 'Contactar al equipo' : 'Contact the team'}</a>
    </div>
  </div>
</section>

<section class="section section--alt">
  <div class="container">
    <div class="section-head center">
      <span class="eyebrow">${es ? 'Resolvemos tus dudas' : 'Your questions'}</span>
      <h2>${es ? 'Preguntas frecuentes' : 'Frequently asked questions'}</h2>
    </div>
    <div class="faq">
      ${faqs.map(([q, a], i) => `<div class="faq__item">
        <h3 class="faq__q"><button class="faq__btn" type="button" aria-expanded="false" aria-controls="faq-${i}" id="faq-btn-${i}">${q}${icon('chevron')}</button></h3>
        <div class="faq__panel" id="faq-${i}" role="region" aria-labelledby="faq-btn-${i}" hidden><p>${a}</p></div>
      </div>`).join('')}
    </div>
  </div>
</section>

${ctaBand(lang)}`;
}

function aboutBody(lang) {
  const es = lang === 'es';
  const p = photo('nosotros');
  const topics = es
    ? [
        ['user', 'Tus antecedentes.', 'Prepara información sobre tu salud y los tratamientos que recibes.'],
        ['target', 'Tus objetivos.', 'Explica qué te preocupa y qué deseas conocer.'],
        ['layers', 'Las opciones.', 'Pregunta qué alternativas son pertinentes para tu caso.'],
        ['info', 'Los riesgos.', 'Solicita información sobre precauciones y posibles efectos adversos.'],
        ['eye', 'Las expectativas.', 'Aclara qué se puede esperar y qué no puede garantizarse.'],
        ['repeat', 'El seguimiento.', 'Pregunta cómo se revisaría tu evolución si inicias un tratamiento.'],
      ]
    : [
        ['user', 'Your medical history.', 'Prepare information about your health and current treatments.'],
        ['target', 'Your goals.', 'Explain your concerns and what you would like to learn.'],
        ['layers', 'Your options.', 'Ask which alternatives may be relevant to your circumstances.'],
        ['info', 'The risks.', 'Ask about precautions and possible adverse effects.'],
        ['eye', 'Expectations.', 'Clarify what may be expected and what cannot be guaranteed.'],
        ['repeat', 'Follow-up.', 'Ask how your progress would be reviewed if you start treatment.'],
      ];
  const access = es
    ? [
        ['search', 'Explora los tratamientos.', 'Revisa la información inicial de cada opción.', url('treatments', lang)],
        ['clipboard', 'Prepara tus preguntas.', 'Organiza lo que quieres conversar en consulta.', url('visit', lang)],
        ['chat', 'Solicita información.', 'Contacta al equipo por el medio que prefieras.', url('contact', lang)],
        ['compass', 'Planea tu visita.', 'Consulta la ubicación y confirma disponibilidad.', `${url('contact', lang)}#ubicacion`],
      ]
    : [
        ['search', 'Explore treatments.', 'Read introductory information about each option.', url('treatments', lang)],
        ['clipboard', 'Prepare your questions.', 'Organize what you want to discuss during your visit.', url('visit', lang)],
        ['chat', 'Request information.', 'Contact the team using your preferred channel.', url('contact', lang)],
        ['compass', 'Plan your visit.', 'Check the location and confirm availability.', `${url('contact', lang)}#ubicacion`],
      ];

  let team = '';
  if (SHOW_TEAM) {
    for (const m of TEAM) {
      if (!m.title.es || !m.title.en || !m.license) throw new Error(`SHOW_TEAM: faltan título o cédula confirmados de ${m.name}`);
    }
    team = `<section class="section">
  <div class="container">
    <div class="section-head center"><h2>${es ? 'Conoce al equipo médico' : 'Meet the medical team'}</h2></div>
    <div class="grid grid--2">${TEAM.map((m) => `<article class="card">
      ${m.photo ? `<img src="/${m.photo}" alt="${esc(m.name)}" loading="lazy" style="border-radius:12px;margin-bottom:20px">` : `<div class="card__icon">${icon('user')}</div>`}
      <h3>${esc(m.name)}</h3>
      <p>${esc(m.title[lang])}</p>
      <p>${es ? 'Cédula profesional' : 'Professional license'}: ${esc(m.license)}</p>
    </article>`).join('')}</div>
  </div>
</section>`;
  }

  return `
${banner(lang, {
  title: es ? 'Conoce Medicina Regenerativa' : 'About Medicina Regenerativa',
  text: es ? 'Información sobre nuestro enfoque y tu próxima consulta en Tijuana.' : 'Learn about our focus and your next consultation in Tijuana.',
})}

<section class="section">
  <div class="container split">
    ${p
      ? `<div class="photo-frame">${img(p, lang, 'loading="lazy"')}</div>`
      : `<div class="hero-visual" style="justify-self:start"><div class="hero-visual__panel">${heroArt()}</div></div>`}
    <div class="split__text">
      <h2>${es ? 'Un espacio para conocer tus opciones' : 'A place to explore your options'}</h2>
      <p>${es
        ? 'Medicina Regenerativa se enfoca en terapias biológicas y regenerativas en Tijuana. Este sitio reúne información inicial sobre los tratamientos presentados por la clínica y las formas de contactar al equipo.'
        : 'Medicina Regenerativa focuses on biological and regenerative therapies in Tijuana. This website provides introductory information about the treatments presented by the clinic and how to contact the team.'}</p>
      <p>${es
        ? 'Si deseas conocer una opción específica, solicita una valoración para conversar sobre tu caso y aclarar tus preguntas antes de decidir.'
        : 'If you would like to learn about a particular option, request a consultation to discuss your circumstances and ask questions before making a decision.'}</p>
      <a class="btn btn--primary" href="${url('treatments', lang)}">${es ? 'Conocer los tratamientos' : 'Explore treatments'}</a>
    </div>
  </div>
</section>

<section class="section section--alt">
  <div class="container">
    <div class="section-head center"><h2>${es ? 'Qué conversar durante tu valoración' : 'What to discuss during your consultation'}</h2></div>
    <div class="grid grid--3">
      ${topics.map(([ic, title, text]) => `<article class="card"><div class="card__icon">${icon(ic)}</div><h3>${title}</h3><p>${text}</p></article>`).join('')}
    </div>
  </div>
</section>

${team}

<section class="section">
  <div class="container">
    <div class="section-head center"><h2>${es ? 'Encuentra la información que necesitas' : 'Find the information you need'}</h2></div>
    <div class="grid grid--4">
      ${access.map(([ic, title, text, href]) => `<a class="card card--link" href="${href}"><div class="card__icon">${icon(ic)}</div><h3>${title}</h3><p>${text}</p><span class="link-arrow" aria-hidden="true">${icon('arrow')}</span></a>`).join('')}
    </div>
  </div>
</section>

${ctaBand(lang)}`;
}

function treatmentsBody(lang) {
  const es = lang === 'es';
  return `
${banner(lang, {
  title: es ? 'Conoce nuestros tratamientos' : 'Explore our treatments',
  text: es
    ? 'Solicita información sobre cada opción y consulta su pertinencia con el médico. La selección de un tratamiento requiere revisar las circunstancias de cada persona.'
    : "Request information about each option and discuss its suitability with a physician. Treatment selection requires an assessment of each person's circumstances.",
})}

<section class="section">
  <div class="container">
    <div class="grid ${gridFor(PUBLISHED.length)}">${PUBLISHED.map((c) => treatmentCard(lang, c)).join('')}</div>
  </div>
</section>

<section class="section section--alt">
  <div class="container">
    <div class="logistics">
      <div class="card__icon">${icon('clipboard')}</div>
      <div>
        <h2>${es ? 'Antes de elegir un tratamiento' : 'Before choosing a treatment'}</h2>
        <p>${es
          ? 'Pregunta por el producto o técnica, la evidencia disponible, los riesgos, las alternativas y el costo total. Una descripción en este sitio no determina si un procedimiento es adecuado para ti.'
          : 'Ask about the product or technique, available evidence, risks, alternatives, and total cost. A description on this website does not determine whether a procedure is suitable for you.'}</p>
      </div>
      <a class="btn btn--primary" href="${url('visit', lang)}">${es ? 'Preparar mi consulta' : 'Prepare for my visit'}</a>
    </div>
  </div>
</section>

${ctaBand(lang)}`;
}

function fichaBody(lang, code) {
  const es = lang === 'es';
  const tr = TREATMENTS[code];
  const wa = waUrl(`${WA_TEXT[lang]} ${es ? `Me interesa información sobre ${tr.name.es}.` : `I would like information about ${tr.name.en}.`}`);
  return `
${banner(lang, {
  title: tr.name[lang],
  text: tr.intro[lang],
  crumbs: [
    [es ? 'Inicio' : 'Home', url('home', lang)],
    [es ? 'Tratamientos' : 'Treatments', url('treatments', lang)],
    [tr.name[lang], null],
  ],
})}

${FACTS[code] ? `<section class="section section--tight" style="padding-top:64px">
  <div class="container">
    <div class="section-head"><h2>${es ? 'Lo que debes saber' : 'What to know'}</h2>
      <p>${es ? 'Información proporcionada por la clínica. El esquema y la pertinencia de cada tratamiento se definen en la valoración médica.' : 'Information provided by the clinic. The schedule and suitability of each treatment are determined at the medical consultation.'}</p></div>
    <div class="grid grid--2">${FACTS[code].map((f) => `<article class="card row-card"><div class="card__icon">${icon(f.icon)}</div><div><h3>${f.h[lang]}</h3><p>${f.p[lang]}</p></div></article>`).join('')}</div>
  </div>
</section>` : ''}

<section class="section section--alt">
  <div class="container">
    <div class="section-head"><h2>${es ? 'Qué preguntar antes de decidir' : 'Questions to ask before deciding'}</h2></div>
    <ol class="qlist">${tr.questions[lang].map((q) => `<li>${q}</li>`).join('')}</ol>
  </div>
</section>

<section class="section">
  <div class="container">
    <div class="ficha-assess">
      <div class="card">
        <h2 class="h3" style="font-size:clamp(22px,2.2vw,26px)">${es ? 'Tu caso requiere una valoración individual' : 'Your circumstances require an individual assessment'}</h2>
        <p>${es
          ? 'La información inicial no permite determinar si este tratamiento es adecuado para ti. Antes de decidir, revisa con el médico tus antecedentes, las expectativas, los riesgos y las alternativas.'
          : 'Introductory information cannot determine whether this treatment is suitable for you. Before deciding, review your medical history, expectations, risks, and alternatives with a physician.'}</p>
        <p class="support-line">${icon('info')}<span>${es
          ? 'Consulta también el costo total, los cuidados y el seguimiento antes de iniciar.'
          : 'Also ask about the total cost, aftercare, and follow-up before starting.'}</span></p>
      </div>
      <div class="card ficha-assess__cta">
        <div class="card__icon" style="background:rgba(255,255,255,.1);color:var(--teal-light)">${icon('chat')}</div>
        <h3>${tr.name[lang]}</h3>
        <div class="btn-row" style="flex-direction:column;align-items:stretch">
          <a class="btn btn--light" href="${url('contact', lang)}?t=${code}#formulario">${es ? 'Solicitar información sobre este tratamiento' : 'Ask about this treatment'}</a>
          <a class="btn btn--ghost-light" href="${wa}" target="_blank" rel="noopener">${icon('chat')}${t(lang, L.whatsapp)}</a>
        </div>
      </div>
    </div>
    <p class="back-link"><a class="link-arrow" href="${url('treatments', lang)}">${es ? 'Ver otros tratamientos' : 'Explore other treatments'}${icon('arrow')}</a></p>
  </div>
</section>`;
}

function visitBody(lang) {
  const es = lang === 'es';
  const blocks = es
    ? [
        ['target', 'Tu motivo de consulta.', 'Describe qué te preocupa y qué información estás buscando. No necesitas elegir un tratamiento antes de pedir una valoración.'],
        ['list', 'Tus antecedentes.', 'Prepara una lista de medicamentos, suplementos, alergias y tratamientos actuales para conversar con el médico. Pregunta al equipo qué documentos conviene llevar.'],
        ['clipboard', 'Tus preguntas.', 'Anota lo que deseas saber sobre las opciones, los riesgos, las expectativas y el costo.'],
      ]
    : [
        ['target', 'The reason for your visit.', 'Describe your concerns and the information you are looking for. You do not need to choose a treatment before requesting a consultation.'],
        ['list', 'Your medical history.', 'Prepare a list of medications, supplements, allergies, and current treatments to discuss with the physician. Ask the team which documents to bring.'],
        ['clipboard', 'Your questions.', 'Write down what you want to know about the options, risks, expectations, and cost.'],
      ];
  const cards = es
    ? [
        ['layers', 'Conoce la propuesta.', 'Pregunta qué se recomienda, por qué y qué alternativas existen.'],
        ['eye', 'Aclara las expectativas.', 'Conversa sobre la evidencia disponible, las limitaciones y la forma de evaluar la evolución.'],
        ['repeat', 'Revisa los siguientes pasos.', 'Solicita información sobre costos, cuidados, seguimiento y a quién contactar si tienes dudas.'],
      ]
    : [
        ['layers', 'Understand the proposal.', 'Ask what is being recommended, why, and what alternatives are available.'],
        ['eye', 'Clarify expectations.', 'Discuss the available evidence, limitations, and how progress would be assessed.'],
        ['repeat', 'Review the next steps.', 'Ask about costs, aftercare, follow-up, and whom to contact with questions.'],
      ];
  return `
${banner(lang, {
  title: es ? 'Prepárate para tu consulta' : 'Prepare for your consultation',
  text: es
    ? 'Organiza tus preguntas y la información que deseas conversar con el médico.'
    : 'Organize your questions and the information you would like to discuss with the physician.',
})}

<section class="section">
  <div class="container">
    <div class="stack" style="margin:0 auto">
      ${blocks.map(([ic, title, text], i) => `<article class="card row-card">
        <div class="card__num" aria-hidden="true">${i + 1}</div>
        <div><h2 class="h3">${title}</h2><p>${text}</p></div>
      </article>`).join('')}
    </div>
  </div>
</section>

<section class="section section--alt">
  <div class="container">
    <div class="section-head center"><h2>${es ? 'Antes de tomar una decisión' : 'Before making a decision'}</h2></div>
    <div class="grid grid--3">
      ${cards.map(([ic, title, text]) => `<article class="card"><div class="card__icon">${icon(ic)}</div><h3>${title}</h3><p>${text}</p></article>`).join('')}
    </div>
  </div>
</section>

<section class="section">
  <div class="container">
    <div class="logistics">
      <div class="card__icon">${icon('map')}</div>
      <div>
        <h2>${es ? '¿Visitas Tijuana desde otra ciudad?' : 'Traveling to Tijuana from another city?'}</h2>
        <p>${es
          ? 'Confirma disponibilidad, ubicación y las condiciones de tu visita antes de organizar tu traslado. Si prefieres atención en inglés, consulta su disponibilidad con el equipo.'
          : 'Confirm availability, location, and arrangements for your visit before planning your trip. If you prefer care in English, ask the team about availability.'}</p>
      </div>
      <a class="btn btn--primary" href="${url('contact', lang)}#formulario">${es ? 'Consultar disponibilidad' : 'Check availability'}</a>
    </div>
  </div>
</section>

${ctaBand(lang)}`;
}

function contactBody(lang) {
  const es = lang === 'es';
  const options = [
    ['general', { es: 'Información general', en: 'General information' }],
    ...PUBLISHED.map((c) => [c, TREATMENTS[c].name]),
  ];
  const req = `<span class="req" aria-hidden="true">*</span>`;
  const optional = `<span class="opt">(${es ? 'opcional' : 'optional'})</span>`;
  const item = (href, ic, label, value, external = false) =>
    `<a class="contact-item" href="${href}"${external ? ' target="_blank" rel="noopener"' : ''}><span class="card__icon">${icon(ic)}</span><span><small>${label}</small><strong>${value}</strong></span></a>`;

  return `
${banner(lang, {
  title: es ? 'Hablemos de tu próxima consulta' : "Let's talk about your next consultation",
  text: es
    ? 'Déjanos tus datos y el tratamiento sobre el que deseas información. También puedes comunicarte por teléfono o WhatsApp.'
    : 'Share your contact details and the treatment you would like to learn about. You can also reach us by phone or WhatsApp.',
})}

<section class="section section--alt">
  <div class="container contact-grid">
    <div>
      <div class="contact-list">
        ${item(`tel:${C.phoneMx.tel}`, 'phone', es ? 'Teléfono en México' : 'Mexico phone', C.phoneMx.display)}
        ${item(`tel:${C.phoneUs.tel}`, 'phone', es ? 'Teléfono en Estados Unidos' : 'U.S. phone', C.phoneUs.display)}
        ${item(waUrl(WA_TEXT[lang]), 'chat', es ? 'Escribir por WhatsApp' : 'Message us on WhatsApp', C.whatsapp.display, true)}
        ${item(`mailto:${C.email}`, 'mail', es ? 'Correo electrónico' : 'Email', C.email)}
      </div>
      <ul class="contact-notes">
        <li>${icon('calendar')}<span>${es ? 'Consulta disponibilidad antes de tu visita.' : 'Please confirm availability before your visit.'}</span></li>
        <li>${icon('chat')}<span>${es ? 'Consulta con el equipo la disponibilidad de atención en inglés.' : 'Ask the team about the availability of care in English.'}</span></li>
      </ul>
    </div>

    <div class="form-card" id="formulario">
      <h2>${es ? 'Solicita información' : 'Request information'}</h2>
      <p class="form-intro">${es
        ? 'Este formulario es para contacto inicial; evita incluir datos médicos sensibles.'
        : 'This form is for initial contact; please avoid including sensitive medical information.'}</p>
      <form id="contact-form" novalidate data-thanks="${url('thanks', lang)}">
        <div class="form-grid">
          <div class="field field--full">
            <label for="full_name">${es ? 'Nombre completo' : 'Full name'} ${req}</label>
            <input id="full_name" name="full_name" type="text" autocomplete="name" required maxlength="120" aria-describedby="err-full_name">
            <p class="field__error" id="err-full_name" aria-live="polite"></p>
          </div>
          <div class="field">
            <label for="phone">${es ? 'Teléfono con código de país' : 'Phone number with country code'} ${req}</label>
            <input id="phone" name="phone" type="tel" autocomplete="tel" inputmode="tel" required maxlength="40" placeholder="${es ? '+52 664 000 0000' : '+1 619 000 0000'}" aria-describedby="err-phone">
            <p class="field__error" id="err-phone" aria-live="polite"></p>
          </div>
          <div class="field">
            <label for="email">${es ? 'Correo electrónico' : 'Email address'} ${optional}</label>
            <input id="email" name="email" type="email" autocomplete="email" maxlength="160" aria-describedby="err-email">
            <p class="field__error" id="err-email" aria-live="polite"></p>
          </div>
          <div class="field field--full">
            <label for="treatment_interest">${es ? 'Tratamiento de interés' : 'Treatment of interest'} ${req}</label>
            <select id="treatment_interest" name="treatment_interest" required aria-describedby="err-treatment_interest">
              ${options.map(([v, label], i) => `<option value="${v}"${i === 0 ? ' selected' : ''}>${label[lang]}</option>`).join('')}
            </select>
            <p class="field__error" id="err-treatment_interest" aria-live="polite"></p>
          </div>
          <div class="field field--full">
            <fieldset aria-describedby="err-preferred_language">
              <legend>${es ? 'Idioma preferido para el contacto' : 'Preferred contact language'} ${req}</legend>
              <div class="choice-row">
                <label class="choice"><input type="radio" name="preferred_language" value="es"${es ? ' checked' : ''}> Español</label>
                <label class="choice"><input type="radio" name="preferred_language" value="en"${es ? '' : ' checked'}> English</label>
              </div>
            </fieldset>
            <p class="field__error" id="err-preferred_language" aria-live="polite"></p>
          </div>
          <div class="field field--full">
            <label for="contact_message">${es ? 'Mensaje, sin información médica sensible' : 'Message, without sensitive medical information'} ${optional}</label>
            <textarea id="contact_message" name="contact_message" rows="4" aria-describedby="msg-counter err-contact_message"></textarea>
            <p class="counter" id="msg-counter">0 / 500</p>
            <p class="field__error" id="err-contact_message" aria-live="polite"></p>
          </div>
          <div class="field field--full">
            <label class="consent"><input type="checkbox" name="contact_consent" required aria-describedby="err-contact_consent"><span>${es
              ? `He leído el <a href="${url('privacy', lang)}" target="_blank">Aviso de privacidad</a> y autorizo que me contacten para atender esta solicitud.`
              : `I have read the <a href="${url('privacy', lang)}" target="_blank">Privacy notice</a> and authorize contact regarding this request.`}</span></label>
            <p class="field__error" id="err-contact_consent" aria-live="polite"></p>
          </div>
          <div class="hp" aria-hidden="true"><label for="company">Company</label><input id="company" name="company" type="text" tabindex="-1" autocomplete="off"></div>
        </div>
        <div class="form-actions"><button class="btn btn--primary" type="submit">${es ? 'Solicitar contacto' : 'Request contact'}</button></div>
        <p class="form-status" id="form-status" role="alert"></p>
      </form>
    </div>
  </div>
</section>

<section class="section" id="ubicacion">
  <div class="container location">
    <div>
      <h2>${es ? 'Encuéntranos en Tijuana' : 'Find us in Tijuana'}</h2>
      <address>${C.address[lang].join('<br>')}</address>
      <p>${es ? 'Confirma la ubicación y disponibilidad antes de tu visita.' : 'Confirm the location and availability before your visit.'}</p>
      <div class="btn-row"><a class="btn btn--primary" href="${MAPS_URL}" target="_blank" rel="noopener">${icon('pin')}${es ? 'Ver ubicación en el mapa' : 'View location on the map'}</a></div>
    </div>
    <div class="location__art">${locationArt()}</div>
  </div>
</section>`;
}

function thanksBody(lang) {
  const es = lang === 'es';
  return `
<section class="thanks">
  <div class="container">
    <div class="thanks__card">
      <div class="thanks__icon">${icon('check')}</div>
      <h1>${es ? 'Recibimos tu solicitud' : 'We received your request'}</h1>
      <p>${es
        ? 'Gracias por contactar a Medicina Regenerativa. Revisaremos tu mensaje para dar seguimiento a tu solicitud.'
        : 'Thank you for contacting Medicina Regenerativa. We will review your message and follow up on your request.'}</p>
      <p class="thanks__note">${es
        ? 'El envío de este formulario no confirma una cita. La fecha y el horario se acuerdan con el equipo.'
        : 'Submitting this form does not confirm an appointment. The date and time must be arranged with the team.'}</p>
      <div class="btn-row">
        <a class="btn btn--primary" href="${url('home', lang)}">${es ? 'Volver al inicio' : 'Back to home'}</a>
        <a class="btn btn--secondary" href="${waUrl(WA_TEXT[lang])}" target="_blank" rel="noopener">${icon('chat')}${t(lang, L.whatsapp)}</a>
      </div>
    </div>
  </div>
</section>`;
}

function privacyBody(lang) {
  const es = lang === 'es';
  const addr = C.address[lang].join(', ');
  const mail = `<a href="mailto:${C.email}">${C.email}</a>`;
  const content = es
    ? `
      <p class="legal__date">Última actualización: ${PAGE_DATE.es}</p>
      <h2>Responsable</h2>
      <p>Medicina Regenerativa, con domicilio en ${addr}, es responsable del tratamiento de los datos personales que nos proporcionas a través de este sitio, conforme a la Ley Federal de Protección de Datos Personales en Posesión de los Particulares.</p>
      <h2>Datos que recabamos</h2>
      <p>A través del formulario de contacto recabamos: nombre completo, teléfono, correo electrónico (opcional), tratamiento de interés, idioma preferido para el contacto y, si decides escribirlo, un mensaje.</p>
      <p>El formulario no está destinado a recibir datos de salud. Te pedimos no incluir diagnósticos, estudios, fotografías médicas ni otra información sensible; esa información se conversa directamente durante la valoración.</p>
      <h2>Finalidades</h2>
      <ul>
        <li>Atender tu solicitud de información y comunicarnos contigo por el medio y en el idioma que indicaste.</li>
        <li>Dar seguimiento a tu solicitud para consultar disponibilidad y organizar una valoración.</li>
      </ul>
      <p>No usamos estos datos para enviarte publicidad sin tu consentimiento por separado.</p>
      <h2>Transferencias y encargados</h2>
      <p>No vendemos ni rentamos tus datos. Los datos se almacenan en las herramientas que usamos para gestionar solicitudes y comunicaciones, que los tratan por nuestra cuenta y solo para las finalidades descritas. Podremos compartirlos cuando una autoridad competente lo requiera conforme a la ley.</p>
      <h2>Derechos ARCO y revocación del consentimiento</h2>
      <p>Puedes solicitar el acceso, rectificación, cancelación u oposición al tratamiento de tus datos, así como revocar tu consentimiento o limitar su uso, escribiendo a ${mail}. Indica tu nombre completo, un medio para responderte y el derecho que deseas ejercer. Te responderemos en un plazo máximo de veinte días hábiles.</p>
      <h2>Cookies</h2>
      <p>Este sitio no utiliza cookies publicitarias ni herramientas de seguimiento de terceros.</p>
      <h2>Cambios a este aviso</h2>
      <p>Cualquier cambio a este aviso se publicará en esta página con su fecha de actualización.</p>`
    : `
      <p class="legal__date">Last updated: ${PAGE_DATE.en}</p>
      <h2>Data controller</h2>
      <p>Medicina Regenerativa, located at ${addr}, is responsible for the personal data you provide through this website, in accordance with Mexico's Federal Law on the Protection of Personal Data Held by Private Parties.</p>
      <h2>Data we collect</h2>
      <p>Through the contact form we collect your full name, phone number, email address (optional), treatment of interest, preferred contact language and, if you choose to write one, a message.</p>
      <p>The form is not intended to receive health information. Please do not include diagnoses, test results, medical photographs, or other sensitive information; those are discussed directly during the consultation.</p>
      <h2>Purposes</h2>
      <ul>
        <li>To respond to your request for information and contact you through the channel and in the language you selected.</li>
        <li>To follow up on your request, check availability, and arrange a consultation.</li>
      </ul>
      <p>We do not use this data to send you advertising without your separate consent.</p>
      <h2>Transfers and processors</h2>
      <p>We do not sell or rent your data. It is stored in the tools we use to manage requests and communications, which process it on our behalf and only for the purposes described. We may share it when required by a competent authority under applicable law.</p>
      <h2>Your rights and withdrawal of consent</h2>
      <p>You may request access to, rectification, cancellation of, or objection to the processing of your data, withdraw your consent, or limit its use by writing to ${mail}. Include your full name, a way to reply to you, and the right you wish to exercise. We will respond within twenty business days.</p>
      <h2>Cookies</h2>
      <p>This website does not use advertising cookies or third-party tracking tools.</p>
      <h2>Changes to this notice</h2>
      <p>Any changes to this notice will be published on this page with the date of the update.</p>`;
  return `
${banner(lang, { title: es ? 'Aviso de privacidad' : 'Privacy notice' })}
<section class="section"><div class="container"><div class="legal">${content}</div></div></section>`;
}

// ─── Plantilla de página ────────────────────────────────────────────────────────
const abs = (path) => `${SITE_URL}${path === '/' ? '' : path}` || '/';

function page({ lang, key, title, description, index, body, jsonLd = null }) {
  const path = ROUTES[key][lang];
  const pairPath = ROUTES[key][other(lang)];
  const indexable = Boolean(SITE_URL) && index;
  const seo = SITE_URL
    ? `<link rel="canonical" href="${abs(path)}">
<link rel="alternate" hreflang="es" href="${abs(ROUTES[key].es)}">
<link rel="alternate" hreflang="en" href="${abs(ROUTES[key].en)}">
<meta property="og:url" content="${abs(path)}">
<meta property="og:image" content="${SITE_URL}/assets/og.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">`
    : '';
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
${indexable ? '' : '<meta name="robots" content="noindex, nofollow">\n'}${seo}
<meta property="og:type" content="website">
<meta property="og:site_name" content="Medicina Regenerativa">
<meta property="og:locale" content="${lang === 'es' ? 'es_MX' : 'en_US'}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="theme-color" content="#123A56">
<link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/assets/apple-touch-icon.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap">
<link rel="stylesheet" href="/assets/site.css?v=${V_CSS}">
<script src="/assets/site.js?v=${V_JS}" defer></script>
<noscript><style>.faq__panel[hidden]{display:block}</style></noscript>
${jsonLd ? `<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>\n` : ''}</head>
<body>
<a class="skip-link" href="#contenido">${t(lang, L.skip)}</a>
${header(lang, key, pairPath)}
<main id="contenido" tabindex="-1">
${body}
</main>
${footer(lang)}
</body>
</html>
`;
}

// ─── Metadatos (plan §17) ───────────────────────────────────────────────────────
const META = {
  home: {
    es: ['Medicina Regenerativa en Tijuana', 'Conoce los tratamientos de Medicina Regenerativa en Tijuana. Solicita información y consulta disponibilidad para una valoración médica.'],
    en: ['Medicina Regenerativa in Tijuana', 'Explore treatments at Medicina Regenerativa in Tijuana. Request information and ask about availability for a medical consultation.'],
  },
  about: {
    es: ['Nosotros — Medicina Regenerativa Tijuana', 'Conoce el enfoque de Medicina Regenerativa en Tijuana y encuentra información para preparar tu próxima consulta.'],
    en: ['About us — Medicina Regenerativa Tijuana', 'Learn about Medicina Regenerativa in Tijuana and find information to help you prepare for your next consultation.'],
  },
  treatments: {
    es: ['Tratamientos — Medicina Regenerativa Tijuana', 'Consulta información inicial sobre nuestros tratamientos y contacta al equipo para conversar sobre una valoración médica.'],
    en: ['Treatments — Medicina Regenerativa Tijuana', 'Read introductory information about our treatments and contact the team to ask about a medical consultation.'],
  },
  visit: {
    es: ['Prepara tu consulta — Medicina Regenerativa', 'Organiza tus preguntas sobre tratamientos, riesgos, alternativas, costos y seguimiento antes de tu visita a Medicina Regenerativa.'],
    en: ['Prepare for your visit — Medicina Regenerativa', 'Organize your questions about treatments, risks, alternatives, costs, and follow-up before visiting Medicina Regenerativa.'],
  },
  contact: {
    es: ['Contacto — Medicina Regenerativa Tijuana', 'Contacta a Medicina Regenerativa en Tijuana por teléfono, WhatsApp o formulario. Consulta disponibilidad para tu valoración.'],
    en: ['Contact — Medicina Regenerativa Tijuana', 'Contact Medicina Regenerativa in Tijuana by phone, WhatsApp, or contact form. Ask about consultation availability.'],
  },
  thanks: {
    es: ['Recibimos tu solicitud — Medicina Regenerativa', 'Gracias por contactar a Medicina Regenerativa.'],
    en: ['We received your request — Medicina Regenerativa', 'Thank you for contacting Medicina Regenerativa.'],
  },
  privacy: {
    es: ['Aviso de privacidad — Medicina Regenerativa', 'Aviso de privacidad del sitio de Medicina Regenerativa en Tijuana.'],
    en: ['Privacy notice — Medicina Regenerativa', 'Privacy notice for the Medicina Regenerativa website in Tijuana.'],
  },
};

const clinicLd = (lang) =>
  SITE_URL
    ? {
        '@context': 'https://schema.org',
        '@type': 'MedicalClinic',
        name: 'Medicina Regenerativa',
        url: abs(ROUTES.home[lang]),
        telephone: C.phoneMx.tel,
        email: C.email,
        address: {
          '@type': 'PostalAddress',
          streetAddress: 'Diego Rivera 2563, Plaza Thamarc, Local 1, Zona Río',
          addressLocality: 'Tijuana',
          addressRegion: 'B.C.',
          postalCode: '22010',
          addressCountry: 'MX',
        },
        sameAs: [C.facebook, C.instagram],
      }
    : null;

// ─── Build ──────────────────────────────────────────────────────────────────────
function cleanGenerated(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (['_src', 'api', 'assets', 'img', 'node_modules', '.vercel'].includes(name) && dir === ROOT) continue;
    if (statSync(p).isDirectory()) {
      cleanGenerated(p);
      if (readdirSync(p).length === 0) rmSync(p, { recursive: true });
    } else if (name.endsWith('.html') || name === 'sitemap.xml' || name === 'robots.txt') {
      rmSync(p);
    }
  }
}

const out = [];
function write(path, html, index) {
  const file = path === '/' ? 'index.html' : `${path.slice(1)}/index.html`;
  const full = join(ROOT, file);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, html);
  out.push({ path, file, index });
}

cleanGenerated(ROOT);

const BODIES = { home: homeBody, about: aboutBody, treatments: treatmentsBody, visit: visitBody, contact: contactBody, thanks: thanksBody, privacy: privacyBody };
const INDEX = { home: true, about: true, treatments: true, visit: true, contact: true, thanks: false, privacy: PRIVACY_APPROVED };

for (const lang of ['es', 'en']) {
  for (const key of Object.keys(BODIES)) {
    const [title, description] = META[key][lang];
    write(ROUTES[key][lang], page({ lang, key, title, description, index: INDEX[key], body: BODIES[key](lang), jsonLd: key === 'home' ? clinicLd(lang) : null }), INDEX[key]);
  }
  for (const code of PUBLISHED) {
    const tr = TREATMENTS[code];
    const title = lang === 'es'
      ? `${tr.name.es} en Tijuana — Medicina Regenerativa`
      : `${tr.name.en} in Tijuana — Medicina Regenerativa`;
    const description = lang === 'es'
      ? `Solicita información sobre ${tr.about.es} en Medicina Regenerativa, Tijuana. Consulta sus indicaciones, riesgos y alternativas con el médico.`
      : `Ask about ${tr.about.en} at Medicina Regenerativa in Tijuana. Discuss indications, risks, and alternatives with a physician.`;
    write(ROUTES[`t_${code}`][lang], page({ lang, key: `t_${code}`, title, description, index: true, body: fichaBody(lang, code) }), true);
  }
}

// 404 bilingüe (Vercel sirve 404.html para cualquier ruta inexistente).
writeFileSync(join(ROOT, '404.html'), `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Página no encontrada — Medicina Regenerativa</title>
<meta name="robots" content="noindex, nofollow">
<link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap">
<link rel="stylesheet" href="/assets/site.css?v=${V_CSS}">
</head>
<body>
<main class="thanks">
  <div class="container">
    <div class="thanks__card">
      <div style="display:flex;justify-content:center;margin-bottom:28px">${brand('es')}</div>
      <h1>Página no encontrada</h1>
      <p>La página que buscas no existe o cambió de dirección.</p>
      <p lang="en">The page you are looking for does not exist or has moved.</p>
      <div class="btn-row">
        <a class="btn btn--primary" href="/">Ir al inicio</a>
        <a class="btn btn--secondary" href="/en" lang="en" hreflang="en">Go to the English site</a>
      </div>
    </div>
  </div>
</main>
</body>
</html>
`);

// robots + sitemap: solo con dominio definitivo.
if (SITE_URL) {
  const pairs = new Map();
  for (const [key, r] of Object.entries(ROUTES)) pairs.set(r.es, r).set(r.en, r);
  const urls = out
    .filter((o) => o.index)
    .map((o) => {
      const r = pairs.get(o.path);
      return `  <url>
    <loc>${abs(o.path)}</loc>
    <xhtml:link rel="alternate" hreflang="es" href="${abs(r.es)}"/>
    <xhtml:link rel="alternate" hreflang="en" href="${abs(r.en)}"/>
  </url>`;
    });
  writeFileSync(join(ROOT, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${urls.join('\n')}
</urlset>
`);
  writeFileSync(join(ROOT, 'robots.txt'), `User-agent: *\nAllow: /\n\nSitemap: ${SITE_URL}/sitemap.xml\n`);
} else {
  writeFileSync(join(ROOT, 'robots.txt'), 'User-agent: *\nDisallow: /\n');
}

console.log(`${out.length} páginas + 404 → ${relative(process.cwd(), ROOT) || '.'}`);
console.log(SITE_URL ? `indexable en ${SITE_URL}` : 'modo borrador: noindex en todo (define SITE_URL para publicar)');
