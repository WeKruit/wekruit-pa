/**
 * P4 — AI-vs-human agreement metric + labeled-dataset export.
 *
 * Admin-only callable `paExportEvaluationLabels`. Reads `pa-evaluation-attempts`
 * (paginated by `createdAt` cursor so it can cover the whole collection, not just
 * the 250-row `listEvaluationAttempts` cap), keeps only attempts that carry a
 * `humanReview.label`, and emits one normalized labeled-dataset row per attempt
 * plus an aggregate (overall + per-source agree rate, quality histogram, top
 * error categories, gold count).
 *
 * READ-ONLY: this never writes Firestore, never touches the AI verdict, and never
 * messages anyone. The AI proposed outcome and the human label coexist in every
 * row, exactly as a modern annotation export keeps the model prediction next to
 * the gold label.
 */
import { getFirestore, type Firestore, type Query } from "firebase-admin/firestore"
import { z } from "zod"
import { onCall } from "firebase-functions/v2/https"
import {
  EvaluationAttemptSchema,
  EvaluationSourceSchema,
  PA_COLLECTIONS,
  type EvaluationAttempt,
  type EvaluationErrorCategory,
  type EvaluationLabelDecision,
  type EvaluationOutcome,
  type EvaluationQualityRating,
  type EvaluationSource,
} from "@pa/core-types"
import { requireExternalSupplyAdmin } from "./external-supply/resolve-identity.js"

const PAGE_SIZE = 400
const MAX_ROWS = 50_000

const ExportEvaluationLabelsInputSchema = z.object({
  source: EvaluationSourceSchema.optional(),
  jobId: z.string().min(1).max(200).optional(),
  /** ISO timestamp lower bound on `label.labeledAt` (inclusive). */
  since: z.string().min(1).max(40).optional(),
  /** When true, only attempts whose label.isGoldSample === true are exported. */
  goldOnly: z.boolean().optional(),
})

export type ExportEvaluationLabelsInput = z.infer<typeof ExportEvaluationLabelsInputSchema>

/** One normalized labeled-dataset row: the AI verdict next to the human label. */
export interface EvaluationLabelRow {
  attemptId: string
  source: EvaluationSource
  jobId?: string
  candidateId?: string
  /** The AI's proposed outcome (never mutated by the human label). */
  aiOutcome: EvaluationOutcome
  humanLabel: {
    decision: EvaluationLabelDecision
    correctedOutcome?: EvaluationOutcome
    errorCategories: EvaluationErrorCategory[]
    qualityRating?: EvaluationQualityRating
    rationale?: string
    isGoldSample?: boolean
  }
  /** True iff the labeler agreed with the AI (decision === "agree"). */
  agreed: boolean
  rubricVersion?: string
  reviewer?: string
  labeledAt?: string
}

export interface EvaluationLabelExportAggregate {
  totalLabeled: number
  agreeCount: number
  /** Overall agree rate in [0,1], rounded to 4 dp. 0 when no rows. */
  agreeRate: number
  /** Per-source breakdown — only sources that actually have labeled rows appear. */
  perSource: Record<string, { total: number; agreeCount: number; agreeRate: number }>
  /** qualityRating 1..5 histogram (keys "1".."5"); only rows that set a rating count. */
  qualityHistogram: Record<string, number>
  /** Error-category frequency, descending. */
  topErrorCategories: Array<{ category: EvaluationErrorCategory; count: number }>
  goldCount: number
}

export interface ExportEvaluationLabelsResult {
  ok: true
  generatedAt: string
  filters: ExportEvaluationLabelsInput
  aggregate: EvaluationLabelExportAggregate
  rows: EvaluationLabelRow[]
  /** Newline-delimited JSON (one row per line) — the downloadable dataset. */
  jsonl: string
  /** True when the MAX_ROWS ceiling was hit (the dashboard should narrow the filter). */
  truncated: boolean
}

export interface ExportEvaluationLabelsDeps {
  db: Firestore
  now?: () => string
  /**
   * Test seam: provide the attempt list directly (the in-memory Firestore fake
   * has no `.where()/.orderBy()` cursor support). Production omits this and the
   * paginated Firestore reader runs.
   */
  loadAttempts?: (db: Firestore, filters: ExportEvaluationLabelsInput) => Promise<EvaluationAttempt[]>
}

/**
 * Build the normalized row for one attempt that already carries a human label.
 * Returns null when the attempt has no label (so callers can filter cleanly).
 */
export function normalizeEvaluationLabelRow(attempt: EvaluationAttempt): EvaluationLabelRow | null {
  const label = attempt.humanReview.label
  if (!label) return null
  return {
    attemptId: attempt.attemptId,
    source: attempt.source,
    ...(attempt.jobId ? { jobId: attempt.jobId } : {}),
    ...(attempt.candidateId ? { candidateId: attempt.candidateId } : {}),
    aiOutcome: attempt.proposedOutcome,
    humanLabel: {
      decision: label.decision,
      ...(label.correctedOutcome ? { correctedOutcome: label.correctedOutcome } : {}),
      errorCategories: label.errorCategories ?? [],
      ...(typeof label.qualityRating === "number" ? { qualityRating: label.qualityRating } : {}),
      ...(label.rationale ? { rationale: label.rationale } : {}),
      ...(label.isGoldSample === true ? { isGoldSample: true } : {}),
    },
    agreed: label.decision === "agree",
    ...(label.rubricVersion ? { rubricVersion: label.rubricVersion } : {}),
    ...(label.labeledBy ? { reviewer: label.labeledBy } : {}),
    ...(label.labeledAt ? { labeledAt: label.labeledAt } : {}),
  }
}

function roundRate(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0
  return Math.round((numerator / denominator) * 10_000) / 10_000
}

/**
 * Pure aggregation + JSONL assembly over an already-filtered set of labeled
 * attempts. Separated from Firestore so it can be unit-tested directly.
 */
export function buildEvaluationLabelExport(
  attempts: EvaluationAttempt[],
  filters: ExportEvaluationLabelsInput,
  generatedAt: string,
): Omit<ExportEvaluationLabelsResult, "ok"> {
  const rows: EvaluationLabelRow[] = []
  for (const attempt of attempts) {
    const row = normalizeEvaluationLabelRow(attempt)
    if (!row) continue
    if (filters.goldOnly && row.humanLabel.isGoldSample !== true) continue
    rows.push(row)
  }

  let agreeCount = 0
  let goldCount = 0
  const perSource: EvaluationLabelExportAggregate["perSource"] = {}
  const qualityHistogram: Record<string, number> = {}
  const errorCounts = new Map<EvaluationErrorCategory, number>()

  for (const row of rows) {
    if (row.agreed) agreeCount += 1
    if (row.humanLabel.isGoldSample === true) goldCount += 1

    const bucket = (perSource[row.source] ??= { total: 0, agreeCount: 0, agreeRate: 0 })
    bucket.total += 1
    if (row.agreed) bucket.agreeCount += 1

    const rating = row.humanLabel.qualityRating
    if (typeof rating === "number") {
      const key = String(rating)
      qualityHistogram[key] = (qualityHistogram[key] ?? 0) + 1
    }

    for (const category of row.humanLabel.errorCategories) {
      errorCounts.set(category, (errorCounts.get(category) ?? 0) + 1)
    }
  }

  for (const bucket of Object.values(perSource)) {
    bucket.agreeRate = roundRate(bucket.agreeCount, bucket.total)
  }

  const topErrorCategories = [...errorCounts.entries()]
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category))

  const aggregate: EvaluationLabelExportAggregate = {
    totalLabeled: rows.length,
    agreeCount,
    agreeRate: roundRate(agreeCount, rows.length),
    perSource,
    qualityHistogram,
    topErrorCategories,
    goldCount,
  }

  const jsonl = rows.map((row) => JSON.stringify(row)).join("\n")

  return {
    generatedAt,
    filters,
    aggregate,
    rows,
    jsonl,
    truncated: false,
  }
}

/**
 * Paginated Firestore reader. Pushes `source`/`jobId` to the query layer and
 * walks `createdAt` with a cursor so the export can cover the whole collection.
 * The `since` / `goldOnly` filters apply in memory against the embedded label
 * (Firestore cannot index a never-set nested optional cheaply at this scale).
 */
async function loadLabeledAttempts(
  db: Firestore,
  filters: ExportEvaluationLabelsInput,
): Promise<{ attempts: EvaluationAttempt[]; truncated: boolean }> {
  const attempts: EvaluationAttempt[] = []
  let cursor: string | undefined
  let truncated = false

  // Loop pages until a short page (no more docs) or the MAX_ROWS ceiling.
  for (;;) {
    let q: Query = db.collection(PA_COLLECTIONS.evaluationAttempts)
    if (filters.source) q = q.where("source", "==", filters.source)
    if (filters.jobId) q = q.where("jobId", "==", filters.jobId)
    q = q.orderBy("createdAt", "asc")
    if (cursor) q = q.startAfter(cursor)
    const snap = await q.limit(PAGE_SIZE).get()
    if (snap.empty) break

    for (const doc of snap.docs) {
      const parsed = EvaluationAttemptSchema.safeParse(doc.data())
      if (!parsed.success) continue
      const attempt = parsed.data
      if (!attempt.humanReview.label) continue
      if (filters.since && attempt.humanReview.label.labeledAt) {
        if (attempt.humanReview.label.labeledAt < filters.since) continue
      }
      attempts.push(attempt)
      if (attempts.length >= MAX_ROWS) {
        truncated = true
        break
      }
    }
    if (truncated) break

    const last = snap.docs[snap.docs.length - 1]
    const lastCreatedAt = (last.data() as { createdAt?: unknown }).createdAt
    if (typeof lastCreatedAt !== "string" || snap.size < PAGE_SIZE) break
    cursor = lastCreatedAt
  }

  return { attempts, truncated }
}

export async function runExportEvaluationLabels(
  data: unknown,
  auth: Parameters<typeof requireExternalSupplyAdmin>[0],
  deps: ExportEvaluationLabelsDeps,
): Promise<ExportEvaluationLabelsResult> {
  requireExternalSupplyAdmin(auth)
  const filters = ExportEvaluationLabelsInputSchema.parse(data ?? {})
  const generatedAt = deps.now?.() ?? new Date().toISOString()

  // The test seam returns an attempt list directly; production paginates.
  if (deps.loadAttempts) {
    const attempts = await deps.loadAttempts(deps.db, filters)
    return { ok: true, ...buildEvaluationLabelExport(attempts, filters, generatedAt) }
  }

  const { attempts, truncated } = await loadLabeledAttempts(deps.db, filters)
  const built = buildEvaluationLabelExport(attempts, filters, generatedAt)
  return { ok: true, ...built, truncated: truncated || built.truncated }
}

export const paExportEvaluationLabels = onCall(
  { region: "us-central1", memory: "512MiB", timeoutSeconds: 120 },
  async (req): Promise<ExportEvaluationLabelsResult> => {
    return runExportEvaluationLabels(req.data, req.auth, { db: getFirestore() })
  },
)
