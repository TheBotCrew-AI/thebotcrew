/**
 * Per-conversation extraction: what the lead asked that the bot could not answer,
 * what a human answered instead, and whether the config already had it.
 *
 * Pure half of the pipeline — builds the prompt and validates the model's JSON. The
 * call itself goes through `aux-llm.ts` (tokens billed as `info_gap_extract`).
 *
 * Why the tenant's CURRENT knowledge travels in the prompt: the two failure modes
 * look identical in a transcript ("déjame lo confirmo con el equipo") but need
 * opposite fixes. A fact the config lacks is loaded; a fact the config HAS that the
 * bot did not use is a prompt bug. Only the model with both in front of it can tell
 * them apart, and `already_in_config` is that verdict.
 */

import { z } from 'zod';

/**
 * Controlled topic vocabulary — the coarse key for grouping across runs. The fine
 * key is `topic_label` (see aggregate.ts). `precio` is the busiest: its label names
 * the zones, alphabetically, so "piernas y axilas" and "axilas + piernas" collapse.
 */
export const GAP_TOPICS = [
  'precio',
  'formas_pago',
  'horario',
  'ubicacion',
  'resultados',
  'edad',
  'sucursales',
  'empleo',
  'cancelacion',
  'equipo',
  'preparacion',
  'promocion',
  'servicio_no_listado',
  'otro',
] as const;
export type GapTopic = (typeof GAP_TOPICS)[number];

export const GAP_TARGETS = ['offering', 'faq', 'hours', 'prompt_bug', 'none'] as const;
export type GapTarget = (typeof GAP_TARGETS)[number];

const gapSchema = z.object({
  question: z.string().trim().min(1),
  topic: z.enum(GAP_TOPICS),
  topic_label: z.string().trim().min(1).max(80),
  human_answer: z.string().trim().min(1).nullable(),
  already_in_config: z.boolean(),
  target: z.enum(GAP_TARGETS),
  suggested_text: z.string().trim().min(1).nullable(),
});
const resultSchema = z.object({ gaps: z.array(gapSchema).max(20) });

export type ExtractedGap = z.infer<typeof gapSchema>;
export type ExtractionResult = z.infer<typeof resultSchema>;

export interface TranscriptLine {
  sender: 'lead' | 'bot' | 'human';
  /** ISO timestamp. */
  at: string;
  text: string;
}

export interface ExtractionInput {
  businessName: string;
  transcript: TranscriptLine[];
  /** The tenant's `offering` override, as the bot sees it. */
  offering: string;
  faq: { q: string; a: string }[];
  /** Rendered hours block, as the bot sees it. */
  hours: string;
}

/** Bound the transcript so one long thread cannot blow the token budget. */
const MAX_LINES = 120;
const MAX_CHARS = 14_000;

const SENDER_LABEL: Record<TranscriptLine['sender'], string> = {
  lead: 'LEAD',
  bot: 'BOT',
  human: 'HUMANO',
};

export function renderTranscript(lines: TranscriptLine[]): string {
  const tail = lines.slice(-MAX_LINES);
  const out: string[] = [];
  let chars = 0;
  // Walk from the end so a cap keeps the newest exchanges, then restore order.
  for (let i = tail.length - 1; i >= 0; i--) {
    const l = tail[i]!;
    const stamp = l.at.slice(0, 16).replace('T', ' ');
    const line = `${stamp} [${SENDER_LABEL[l.sender]}] ${l.text.replace(/\s+/g, ' ').trim()}`;
    chars += line.length + 1;
    if (chars > MAX_CHARS) break;
    out.push(line);
  }
  return out.reverse().join('\n');
}

export function buildExtractionPrompt(input: ExtractionInput): string {
  const faq = input.faq.length > 0
    ? input.faq.map((f) => `- P: ${f.q}\n  R: ${f.a}`).join('\n')
    : '- (sin FAQ)';
  return `Eres analista de calidad de un asistente de WhatsApp de ${input.businessName}. Vas a leer UNA conversación y a detectar los huecos de información: preguntas del lead que el asistente (BOT) no pudo contestar con un dato concreto — dijo que lo confirmaría con el equipo, lo pasó a una persona, o contestó algo inventado o contradictorio — y también preguntas que acabó contestando una persona del equipo (HUMANO).

Lo que el BOT sabe HOY (su configuración actual). Úsalo para decidir si el dato YA existía:

=== OFERTA Y REGLAS ===
${input.offering.trim() || '(vacío)'}

=== FAQ ===
${faq}

=== HORARIO ===
${input.hours.trim() || '(sin horario)'}

=== CONVERSACIÓN ===
${renderTranscript(input.transcript)}

Devuelve SOLO un objeto JSON con esta forma exacta:
{"gaps":[{"question":"...","topic":"...","topic_label":"...","human_answer":"..."|null,"already_in_config":true|false,"target":"...","suggested_text":"..."|null}]}

Reglas para cada elemento de "gaps":
- "question": la duda del lead TAL CUAL la escribió (copia literal, sin corregir). Una entrada por duda distinta; si el lead repitió la misma duda varias veces, una sola entrada.
- "topic": uno de: ${GAP_TOPICS.join(', ')}. "precio" para cualquier costo de zona o paquete; "servicio_no_listado" cuando pide un tratamiento o zona que la oferta no menciona; "otro" solo si nada aplica.
- "topic_label": 2 a 4 palabras, solo sustantivos, sin artículos. Para "precio", nombra las zonas en orden alfabético (p. ej. "axilas piernas completas"). Para lo demás, el concepto (p. ej. "edad minima", "pago por sesion").
- "human_answer": lo que contestó el HUMANO a esa duda, condensado y fiel (sin inventar). null si ningún HUMANO la contestó — y es null aunque el BOT la haya contestado, aunque el humano haya hecho una pregunta de vuelta, o aunque haya contestado otra cosa. Nunca escribas aquí un comentario ("no contestó directamente…"): o son palabras del HUMANO, o es null.
- "already_in_config": true SOLO si la configuración de arriba ya contiene el dato que respondería la duda. Si es true, "target" debe ser "prompt_bug" (el bot lo tenía y no lo usó).
- "target": dónde iría el dato que falta: "offering" para precios, paquetes, reglas de cotización o de pago; "faq" para una respuesta cerrada que solo se da si la preguntan; "hours" para horario; "prompt_bug" si already_in_config es true; "none" si no es un dato de negocio (p. ej. una queja, un saludo, o algo que legítimamente debe ver una persona como un tema médico).
- "suggested_text": el renglón listo para pegar en la configuración, en el tono del negocio, basado en la respuesta del humano. null si no hubo respuesta humana o target es "none" o "prompt_bug".

No incluyas: preguntas que el BOT sí contestó con un dato concreto y correcto; solicitudes de cita u horarios disponibles (eso lo revisa una persona por diseño); ni cortesías. Si no hay huecos, devuelve {"gaps":[]}.`;
}

/**
 * Validate the model's JSON. Throws on any shape violation — the runner counts that as
 * a retryable failure (a second sample usually parses).
 */
export function parseExtraction(raw: string): ExtractionResult {
  const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const parsed: unknown = JSON.parse(trimmed);
  return resultSchema.parse(parsed);
}
