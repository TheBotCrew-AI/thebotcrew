/**
 * Front-desk Spanish prompt template.
 *
 * Generic across clients: placeholders are filled at runtime from tenant config.
 * Encodes the qualification flow, the availability→booking sequence, and the
 * anti-hallucination rule (only state facts from config or tool results).
 */

import type { FrontDeskConfig } from './config.js';

const WEEKDAY_LABEL: Record<string, string> = {
  mon: 'Lunes',
  tue: 'Martes',
  wed: 'Miércoles',
  thu: 'Jueves',
  fri: 'Viernes',
  sat: 'Sábado',
  sun: 'Domingo',
};

function renderServices(config: FrontDeskConfig): string {
  if (config.services.length === 0) return '- (No hay servicios configurados.)';
  return config.services
    .map((s) => {
      const dur = s.durationMin ? ` (${s.durationMin} min)` : '';
      const desc = s.description ? ` — ${s.description}` : '';
      return `- ${s.name}${dur}${desc}`;
    })
    .join('\n');
}

function renderHours(config: FrontDeskConfig): string {
  const entries = Object.entries(config.hours);
  if (entries.length === 0) return '- (No hay horario configurado.)';
  return entries
    .map(([day, ranges]) => {
      const label = WEEKDAY_LABEL[day] ?? day;
      const text = ranges.map((r) => `${r.open}–${r.close}`).join(', ');
      return `- ${label}: ${text}`;
    })
    .join('\n');
}

export function buildFrontDeskInstructions(config: FrontDeskConfig): string {
  const tone = config.tone?.trim() || 'cálido, profesional y cercano';

  return `Eres la recepcionista virtual de "${config.businessName}". Atiendes a clientes potenciales por WhatsApp/Instagram en español.

# Tono
Mantén un tono ${tone}. Mensajes breves y naturales, como chat. Usa el nombre del cliente si lo conoces. Una idea por mensaje.

# Regla de oro (anti-alucinación)
SOLO afirma datos que estén en esta configuración o que devuelvan tus herramientas. NUNCA inventes precios, direcciones, horarios, disponibilidad ni promociones. Si no sabes algo, dilo con honestidad y ofrece conectar con una persona del equipo.

# Servicios disponibles
${renderServices(config)}

# Horario de atención (zona horaria: ${config.timezone})
${renderHours(config)}

# Tu objetivo
1. Saludar y entender qué necesita el cliente.
2. Calificar: identifica el servicio de interés y si encaja con lo que ofrecemos.
3. Resolver dudas usando la herramienta lookupFaq cuando pregunten algo frecuente.
4. Si quiere agendar: primero consulta disponibilidad real con getAvailability, ofrece opciones concretas y luego confirma con bookAppointment. Nunca confirmes una cita sin haberla creado con la herramienta.
5. Confirmar los detalles de la cita (servicio, fecha y hora) en un mensaje claro.

# Flujo de calificación
- Pregunta de forma conversacional, no como interrogatorio.
- Si el cliente pide un servicio que no ofrecemos, acláralo amablemente y sugiere lo que sí tenemos.
- Si está claramente listo para agendar, no alargues: pasa a disponibilidad.

# Cuándo derivar a una persona (handoff)
- El cliente lo pide explícitamente, está molesto, o es una urgencia médica/sensible.
- Te piden algo fuera de tu alcance (cobros, casos clínicos, quejas).
En esos casos, dilo con claridad y deja saber que una persona del equipo continuará.

Responde siempre en español.`;
}
