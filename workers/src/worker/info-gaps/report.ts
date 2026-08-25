/**
 * The per-run report, as markdown. Pure.
 *
 * Section order is the reader's priority order:
 *   1. Listo para cargar — a human already answered it (N times); the text is drafted.
 *   2. Preguntar al cliente — nobody has answered it yet.
 *   3. El bot lo tenía y no lo usó — the config has the fact; that is a prompt bug.
 *   3b. Ya está en la config — the fact was loaded AFTER the lead asked (not a bug).
 *   4. Sin respuesta de nadie — pending questions no human picked up (lost leads).
 * Only gaps touched by THIS run appear in 1–3; the accumulated table is the DB.
 */

export interface ReportGap {
  topicKey: string;
  topic: string;
  topicLabel: string;
  status: 'open' | 'closed' | 'dismissed';
  target: string;
  occurrences: number;
  questionExamples: string[];
  humanAnswers: string[];
  suggestedText: string | null;
  firstSeen: string;
  lastSeen: string;
}

export interface UnansweredItem {
  conversationId: string;
  question: string | null;
  lastMessageAt: string | null;
}

export interface ReportInput {
  businessName: string;
  runId: string;
  windowFrom: string;
  windowTo: string;
  candidates: number;
  extracted: number;
  failed: number;
  /** Every open/closed gap of the tenant (the accumulated table). */
  gaps: ReportGap[];
  /** topicKeys upserted by this run. */
  touched: Set<string>;
  unanswered: UnansweredItem[];
  /**
   * When the tenant's config last changed (tenant_config_history). A gap the model
   * judged `already_in_config` but whose conversations all predate this moment is not
   * a prompt bug: the fact was loaded AFTER the lead asked. Only gaps still asked after
   * the change are the real "had it and didn't use it". null = unknown → all count.
   */
  configChangedAt: string | null;
}

export interface ReportSummary {
  readyToLoad: number;
  askClient: number;
  promptBugs: number;
  stillAskedAfterClose: number;
  /** already_in_config gaps whose last question predates the config change — closed, not broken. */
  closedAfterAsked: number;
  unanswered: number;
  candidates: number;
  extracted: number;
  failed: number;
}

const day = (iso: string): string => iso.slice(0, 10);

function quoteList(items: string[], max = 4): string {
  return items.slice(0, max).map((q) => `  - "${q.replace(/\s+/g, ' ').trim()}"`).join('\n');
}

function gapBlock(g: ReportGap, withAnswers: boolean): string {
  const lines = [
    `### ${g.topicLabel} · ${g.occurrences}× · \`${g.topic}\` → \`${g.target}\``,
    `Cómo lo preguntan:`,
    quoteList(g.questionExamples),
  ];
  if (withAnswers && g.humanAnswers.length > 0) {
    lines.push(`Lo que respondió el equipo:`, quoteList(g.humanAnswers, 3));
  }
  if (withAnswers && g.suggestedText) {
    lines.push(`Texto propuesto:`, `> ${g.suggestedText.replace(/\n/g, '\n> ')}`);
  }
  return lines.join('\n');
}

export function buildReport(input: ReportInput): { markdown: string; summary: ReportSummary } {
  const touched = input.gaps.filter((g) => input.touched.has(g.topicKey));
  const open = touched.filter((g) => g.status === 'open');
  const ready = open.filter((g) => g.target !== 'prompt_bug' && g.target !== 'none' && g.humanAnswers.length > 0);
  const ask = open.filter((g) => g.target !== 'prompt_bug' && g.target !== 'none' && g.humanAnswers.length === 0);
  const changedAt = input.configChangedAt ? new Date(input.configChangedAt).getTime() : null;
  const predatesConfig = (g: ReportGap) => changedAt !== null && new Date(g.lastSeen).getTime() < changedAt;
  const bugs = open.filter((g) => g.target === 'prompt_bug' && !predatesConfig(g));
  const closedAfterAsked = open.filter((g) => g.target === 'prompt_bug' && predatesConfig(g));
  const stillAsked = touched.filter((g) => g.status === 'closed');

  const byCount = (a: ReportGap, b: ReportGap) => b.occurrences - a.occurrences;
  ready.sort(byCount);
  ask.sort(byCount);
  bugs.sort(byCount);
  closedAfterAsked.sort(byCount);
  stillAsked.sort(byCount);

  const summary: ReportSummary = {
    readyToLoad: ready.length,
    askClient: ask.length,
    promptBugs: bugs.length + stillAsked.length,
    stillAskedAfterClose: stillAsked.length,
    closedAfterAsked: closedAfterAsked.length,
    unanswered: input.unanswered.length,
    candidates: input.candidates,
    extracted: input.extracted,
    failed: input.failed,
  };

  const md: string[] = [
    `# ${input.businessName} — huecos de información`,
    ``,
    `Ventana: ${day(input.windowFrom)} → ${day(input.windowTo)} · ${input.candidates} conversaciones candidatas, ${input.extracted} leídas` +
      (input.failed > 0 ? `, ${input.failed} fallidas` : '') +
      ` · corrida \`${input.runId}\``,
    ``,
    `| Listo para cargar | Preguntar al cliente | El bot lo tenía | Sin respuesta de nadie |`,
    `|---|---|---|---|`,
    `| ${ready.length} | ${ask.length} | ${bugs.length + stillAsked.length} | ${input.unanswered.length} |`,
    ``,
    `## 1. Listo para cargar — el equipo ya lo contestó`,
    ``,
    ready.length > 0 ? ready.map((g) => gapBlock(g, true)).join('\n\n') : `_Nada nuevo en esta ventana._`,
    ``,
    `## 2. Preguntar al cliente — nadie lo ha contestado`,
    ``,
    ask.length > 0 ? ask.map((g) => gapBlock(g, false)).join('\n\n') : `_Nada nuevo en esta ventana._`,
    ``,
    `## 3. El bot lo tenía y no lo usó`,
    ``,
    bugs.length > 0 || stillAsked.length > 0
      ? [
          ...bugs.map((g) => gapBlock(g, false)),
          ...stillAsked.map((g) => `${gapBlock(g, false)}\n_Cerrado en config el ${day(g.lastSeen)} y aún se pregunta: revisar cómo lo está usando el bot._`),
        ].join('\n\n')
      : `_Ninguno._`,
    ``,
    ...(closedAfterAsked.length > 0
      ? [
          `## 3b. Ya está en la config — se cargó después de estas conversaciones`,
          ``,
          `_${closedAfterAsked.length} tema(s) que el modelo encontró en la config de hoy pero que se preguntaron antes del último cambio (${day(input.configChangedAt!)}). No son bugs; si vuelven a aparecer en la siguiente corrida, sí._`,
          ``,
          closedAfterAsked.map((g) => `- ${g.topicLabel} · ${g.occurrences}× · \`${g.topic}\``).join('\n'),
          ``,
        ]
      : []),
    `## 4. Sin respuesta de nadie`,
    ``,
    input.unanswered.length > 0
      ? input.unanswered
          .map((u) => `- ${u.lastMessageAt ? day(u.lastMessageAt) : '—'} · \`${u.conversationId.slice(0, 8)}\` · ${u.question ? `"${u.question.replace(/\s+/g, ' ').trim()}"` : '(sin pregunta registrada)'}`)
          .join('\n')
      : `_Ninguna: todo \`pending_info\` de la ventana tuvo respuesta humana._`,
    ``,
  ];

  return { markdown: md.join('\n'), summary };
}
