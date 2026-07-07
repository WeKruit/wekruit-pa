/**
 * `paAdminRecruiterSubmissionsList` — admin-only TRIMMED list of EVERY recruiter
 * submission for the dashboard "Recruiter Submissions" table.
 *
 * Why: the page loaded only the 500 most-recent submissions (`limit(500)` +
 * `orderBy("createdAt","desc")`) out of ~3.8k, so search missed most candidates,
 * the state filter only ever saw `submitted` rows (the older rejected/interview/
 * client_review ones were beyond the 500), and 3 docs missing `createdAt` were
 * silently dropped by the orderBy. Loading all 3.8k FULL docs client-side is
 * ~19.5MB (over the callable limit and far too slow), so this returns every
 * submission TRIMMED to just the fields the table + search + filters need
 * (~light maps; excludes aiEvaluation / statusHistory / candidateBackground).
 * The drawer fetches the full doc on open.
 *
 * Architecture mirrors admin-candidate-pool-counts.ts: pure deps-injected runner
 * + thin cached onCall, admin-gated via authorizeAdminCallable.
 */
import { getFirestore, type Firestore } from "firebase-admin/firestore"
import { defineSecret } from "firebase-functions/params"
import { HttpsError, onCall } from "firebase-functions/v2/https"
import { logger } from "firebase-functions/v2"
import { z } from "zod"
import { authorizeAdminCallable } from "./promote-sandbox-tag.js"

const PA_ADMIN_TOKEN = defineSecret("PA_ADMIN_TOKEN")

const SUBMISSIONS_COLLECTION = "pa-recruiter-submissions"
// Generous vs. current ~3.8k; a hit flips `truncated` so the UI can warn.
const SCAN_CAP = 12_000

const CACHE_COLLECTION = "pa-recruiter-submissions-list-cache"
// Short TTL — statuses change as submissions move through the pipeline, so a
// stale browse should self-heal within a minute (the client also patches its
// own cache on each status mutation).
const CACHE_TTL_MS = 60_000
const CACHE_VERSION = "v2"

// Only the fields the table columns, search, and filter chips read. Nested
// paths keep the payload tiny — the heavy aiEvaluation / statusHistory /
// candidateBackground / candidate.notes are deliberately excluded (the drawer
// fetches the full doc on open).
const SELECT_FIELDS = [
  "recruiterId",
  "recruiterEmail",
  "submitter.name",
  "submitter.email",
  "candidate.name",
  "candidate.email",
  "candidate.link",
  "jobId",
  "inboundJobId",
  "jobTitleSnapshot",
  "companyLabelSnapshot",
  "status",
  "score",
  "createdAt",
  "sheetSyncError",
  "sheetSyncedAt",
  "candidateConsentStatus",
  "recruiterFeedbackNote",
  "recruiterFeedbackRating",
  "recruiterFeedbackReasons",
  "recruiterFeedbackUpdatedAt",
  "adminDecision",
  "requestedInfo",
  "companySends",
  "recruiterPayout",
  // Stored eval-attempt stamp — the drawer reads it; without it the client used
  // to recompute a sha256 (server-only) and white-screen.
  "evaluationAttemptId",
] as const

export const AdminRecruiterSubmissionsListInputSchema = z.object({
  adminToken: z.string().nullish(),
})
export type AdminRecruiterSubmissionsListInput = z.infer<typeof AdminRecruiterSubmissionsListInputSchema>

/** A submission Timestamp coerced to `{ seconds }` so the client's existing
 *  `data.createdAt?.seconds` derivation keeps working over the wire. */
function toSecondsObj(value: unknown): { seconds: number } | null {
  if (!value) return null
  if (typeof value === "object") {
    const o = value as { seconds?: number; _seconds?: number; toDate?: () => Date }
    if (typeof o.seconds === "number") return { seconds: o.seconds }
    if (typeof o._seconds === "number") return { seconds: o._seconds }
    if (typeof o.toDate === "function") {
      try {
        const d = o.toDate()
        if (d instanceof Date && Number.isFinite(d.getTime())) return { seconds: Math.floor(d.getTime() / 1000) }
      } catch {
        /* fall through */
      }
    }
  }
  if (typeof value === "number" && Number.isFinite(value)) return { seconds: Math.floor(value / 1000) }
  if (typeof value === "string") {
    const t = Date.parse(value)
    if (Number.isFinite(t)) return { seconds: Math.floor(t / 1000) }
  }
  return null
}

export interface AdminRecruiterSubmissionsListResult {
  rows: Record<string, unknown>[]
  total: number
  truncated: boolean
  generatedAt: string
}

export interface AdminRecruiterSubmissionsListDeps {
  db: Firestore
}

export async function runAdminRecruiterSubmissionsList(
  deps: AdminRecruiterSubmissionsListDeps,
): Promise<AdminRecruiterSubmissionsListResult> {
  // Plain limit, NO orderBy — orderBy("createdAt") drops the 3 docs missing the
  // field. We want every submission; the client sorts.
  const snap = await deps.db.collection(SUBMISSIONS_COLLECTION).select(...SELECT_FIELDS).limit(SCAN_CAP).get()
  const rows = snap.docs.map((d) => {
    const data = d.data() as Record<string, unknown>
    const { createdAt, sheetSyncedAt, recruiterFeedbackUpdatedAt, ...rest } = data
    return {
      id: d.id,
      ...rest,
      // {seconds} plain objects → JSON-safe + back-compatible with the client.
      createdAt: toSecondsObj(createdAt),
      sheetSyncedAt: toSecondsObj(sheetSyncedAt),
      recruiterFeedbackUpdatedAt: toSecondsObj(recruiterFeedbackUpdatedAt),
    }
  })
  return {
    rows,
    total: rows.length,
    truncated: rows.length >= SCAN_CAP,
    generatedAt: new Date().toISOString(),
  }
}

export const paAdminRecruiterSubmissionsList = onCall(
  {
    region: "us-central1",
    memory: "1GiB",
    timeoutSeconds: 120,
    secrets: [PA_ADMIN_TOKEN],
  },
  async (req): Promise<AdminRecruiterSubmissionsListResult> => {
    authorizeAdminCallable(req as { auth?: { token?: { admin?: unknown } }; data?: unknown })
    const parsed = AdminRecruiterSubmissionsListInputSchema.safeParse(req.data ?? {})
    if (!parsed.success) {
      throw new HttpsError("invalid-argument", parsed.error.message)
    }
    const db = getFirestore()
    const cacheRef = db.collection(CACHE_COLLECTION).doc(CACHE_VERSION)
    try {
      const cs = await cacheRef.get()
      const cached = cs.exists
        ? (cs.data() as { cachedAtMs?: number; result?: AdminRecruiterSubmissionsListResult })
        : undefined
      if (cached?.result && typeof cached.cachedAtMs === "number" && Date.now() - cached.cachedAtMs < CACHE_TTL_MS) {
        return cached.result
      }
    } catch {
      /* recompute */
    }
    try {
      const result = await runAdminRecruiterSubmissionsList({ db })
      void cacheRef.set({ cachedAtMs: Date.now(), result }).catch(() => {})
      return result
    } catch (err) {
      logger.error("[admin-recruiter-submissions-list] failed", err)
      throw new HttpsError("internal", "recruiter submissions list failed")
    }
  },
)
