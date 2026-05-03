/**
 * iter30/WS8 — Day-1 stub for match-weights dashboard CRUD.
 *
 * Mirrors `playbooks-api.ts` shape (see file for canonical pattern). Day-1
 * implementations are in-memory placeholders so the `/match-weights` page
 * can render and the wiring contract is locked. Wave-2 swaps the bodies for
 * Firestore reads/writes against:
 *
 *   collection:  pa-match-weight-tables/{tableKey}
 *   subcollection: pa-match-weight-tables/{tableKey}/items/{skillKey}
 *
 * Mutations should batch the row write with an audit row in
 * `PA_COLLECTIONS.auditEvents` (see playbooks-api.ts savePlaybook). All
 * mutations require a `reason` string for audit (Adam constraint per
 * Phase 32 Wave 3 audit pattern).
 */

export type MatchWeightCategory = "core" | "supporting" | "generic"

export type MatchWeightTableMeta = {
  /** Doc id, e.g. `ai-agent-2026`. */
  tableKey: string
  /** Human label. */
  name: string
  /** Free-text. */
  description: string
  /** ISO timestamp string or null. */
  updatedAt: string | null
  updatedBy: string
  /** Number of skill rows currently in the table (cached for list view). */
  rowCount: number
}

export type MatchWeightRow = {
  /** Lower-cased substring matched against required-skills + CV-skills. */
  skill: string
  /** 0.5 (generic) – 3.0 (core hot keyword in 2026 market). */
  weight: number
  category: MatchWeightCategory
  /** ISO timestamp string or null. */
  updatedAt: string | null
  updatedBy: string
}

export type SaveMatchWeightRowInput = {
  tableKey: string
  skill: string
  weight: number
  category: MatchWeightCategory
  reason: string
}

// ---------------------------------------------------------------------------
// Reads (Day-1 stub — returns hardcoded sample so the page renders).
// ---------------------------------------------------------------------------

export async function listWeightTables(): Promise<MatchWeightTableMeta[]> {
  // TODO(WS8 Wave 2): swap for Firestore getDocs against `pa-match-weight-tables`.
  return [
    {
      tableKey: "ai-agent-2026",
      name: "AI Agent / LLM Engineer 2026",
      description:
        "Hand-curated weight table for AI agent roles. Source: apps/job-rec/src/match-weights.ts AI_AGENT_SKILL_WEIGHTS.",
      updatedAt: null,
      updatedBy: "seed-match-weights.mjs",
      rowCount: 0,
    },
  ]
}

export async function getWeightTable(
  tableKey: string
): Promise<MatchWeightTableMeta | null> {
  const tables = await listWeightTables()
  return tables.find((t) => t.tableKey === tableKey) ?? null
}

export async function listRows(_tableKey: string): Promise<MatchWeightRow[]> {
  // TODO(WS8 Wave 2): swap for Firestore getDocs against
  //   pa-match-weight-tables/{tableKey}/items
  return []
}

// ---------------------------------------------------------------------------
// Writes (Day-1 stub — no-op + console log).
// ---------------------------------------------------------------------------

export async function updateRow(input: SaveMatchWeightRowInput): Promise<void> {
  if (!input.reason.trim()) {
    throw new Error("Reason is required (audit log)")
  }
  // TODO(WS8 Wave 2): batch write
  //   pa-match-weight-tables/{tableKey}/items/{skill} (set, merge)
  //   PA_COLLECTIONS.auditEvents (action: "match-weight.update")
  // eslint-disable-next-line no-console
  console.info("[match-weights-api stub] updateRow", input)
}

export async function addRow(input: SaveMatchWeightRowInput): Promise<void> {
  if (!input.reason.trim()) {
    throw new Error("Reason is required (audit log)")
  }
  // TODO(WS8 Wave 2): batched create.
  // eslint-disable-next-line no-console
  console.info("[match-weights-api stub] addRow", input)
}

export async function deleteRow(
  tableKey: string,
  skill: string,
  reason: string
): Promise<void> {
  if (!reason.trim()) {
    throw new Error("Reason is required (audit log)")
  }
  // TODO(WS8 Wave 2): batched delete + audit event.
  // eslint-disable-next-line no-console
  console.info("[match-weights-api stub] deleteRow", { tableKey, skill, reason })
}
