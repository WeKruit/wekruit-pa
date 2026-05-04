/**
 * iter30/WS8 Wave 2 — read-only Firestore wrapper for `pa-job-rec-explanations`.
 *
 * Provides paginated history reads for the `/match/explainer-history` page so
 * operators can spot-check daily-batch explainer output. NOT a write surface
 * — explainer cache writes are owned by `apps/job-rec/src/match-explainer.ts`
 * (server-side, signed-in-as-cloud-functions).
 */
import {
  Timestamp,
  collection,
  getDocs,
  limit as fsLimit,
  orderBy,
  query,
  where,
  type QueryConstraint,
} from "firebase/firestore"
import { db } from "./firebase.js"

export const EXPLANATIONS_COLLECTION = "pa-job-rec-explanations"

export type ExplanationDoc = {
  /** Doc id — `${userId}__${jobId}__${language}[__v{N}]`. */
  id: string
  userId: string
  jobId: string
  language: "zh" | "en"
  reason: string
  matchScore?: number
  /** ISO. */
  createdAt: string | null
  /** ISO. */
  ttlAt: string | null
  /** Parsed from doc id `__v{N}` suffix when present. */
  weightTableVersion: number | null
}

function tsToIso(value: unknown): string | null {
  if (!value) return null
  if (value instanceof Timestamp) return value.toDate().toISOString()
  if (typeof value === "string") return value
  return null
}

function parseVersionFromId(id: string): number | null {
  const m = /__v(\d+)$/.exec(id)
  return m ? Number(m[1]) : null
}

function fromSnap(id: string, raw: Record<string, unknown>): ExplanationDoc {
  const lang = raw.language === "en" ? "en" : "zh"
  return {
    id,
    userId: (raw.userId as string) ?? "",
    jobId: (raw.jobId as string) ?? "",
    language: lang as "zh" | "en",
    reason: (raw.reason as string) ?? "",
    matchScore:
      typeof raw.matchScore === "number" ? raw.matchScore : undefined,
    createdAt: tsToIso(raw.createdAt),
    ttlAt: tsToIso(raw.ttlAt),
    weightTableVersion: parseVersionFromId(id),
  }
}

export type ExplanationFilters = {
  userId?: string
  language?: "zh" | "en"
  /** Page size. Default 25. Capped at 100. */
  pageSize?: number
}

export async function listRecentExplanations(
  filters: ExplanationFilters = {}
): Promise<ExplanationDoc[]> {
  const pageSize = Math.min(100, Math.max(1, filters.pageSize ?? 25))
  const constraints: QueryConstraint[] = []
  if (filters.userId) {
    constraints.push(where("userId", "==", filters.userId))
  }
  if (filters.language) {
    constraints.push(where("language", "==", filters.language))
  }
  constraints.push(orderBy("createdAt", "desc"))
  constraints.push(fsLimit(pageSize))

  const snap = await getDocs(
    query(collection(db(), EXPLANATIONS_COLLECTION), ...constraints)
  )
  return snap.docs.map((d) =>
    fromSnap(d.id, d.data() as Record<string, unknown>)
  )
}
