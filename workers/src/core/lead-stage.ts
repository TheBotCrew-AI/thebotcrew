/**
 * The lead stage vocabulary (0067) on its own, with no imports: `core/stage.ts`
 * computes it from the thread and pulls in `core/tenant.ts` → `db/queries.ts`, so
 * anything the DB layer needs about stages has to come from a leaf module or the
 * import graph turns into a cycle (the 0068 build warned on exactly that).
 */

export type LeadStage = 'NI' | 'I' | 'A' | 'C';
export const LEAD_STAGES: readonly LeadStage[] = ['NI', 'I', 'A', 'C'];
export const STAGE_RANK: Record<LeadStage, number> = { NI: 1, I: 2, A: 3, C: 4 };

export function asLeadStage(raw: unknown): LeadStage | null {
  return typeof raw === 'string' && (LEAD_STAGES as readonly string[]).includes(raw) ? (raw as LeadStage) : null;
}
