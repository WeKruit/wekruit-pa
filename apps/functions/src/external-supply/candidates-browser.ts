/**
 * v2.0 External Supply V2.1 — Candidates browser callables.
 *
 * Backs `/admin/external-supply/batches/:batchId/candidates` (the
 * Lessie/Juicebox-style list + detail drawer). Two read-only operator-only
 * callables:
 *
 *   paExternalSupplyListBatchCandidates({ batchId })
 *     → array of `BatchCandidateRow`: one per `pa-external-candidate-records`
 *       row in the batch, joined to resolved `pa-users` (when available) and
 *       to the most recent `pa-candidate-company-job-evaluations` row for
 *       this candidate + the batch's bound job (if any).
 *
 *   paExternalSupplyGetCandidateDetail({ recordId })
 *     → drawer payload: record + candidate profile + resume artifact +
 *       evaluation + handles list. Never returns raw PII the operator can't
 *       see in the parent list (lower bound is the record itself).
 *
 * Both gated by `requireExternalSupplyAdmin`. Pure Firestore reads — no
 * writes, no LLM calls.
 */
import { z } from "zod"
import { onCall, HttpsError } from "firebase-functions/v2/https"
import { getFirestore, type Firestore } from "firebase-admin/firestore"
import { PA_COLLECTIONS } from "@pa/core-types"
import { requireExternalSupplyAdmin } from "./resolve-identity.js"

// ---------------------------------------------------------------------------
// List candidates by batch
// ---------------------------------------------------------------------------

const ListBatchCandidatesInputSchema = z.object({
  batchId: z.string().min(1),
})

export interface BatchCandidateRow {
  recordId: string
  batchId: string
  candidateId?: string
  name?: string
  linkedinUrl?: string
  currentTitle?: string
  currentCompany?: string
  location?: string
  email?: string
  headline?: string
  matchScore?: string
  /** Verbatim rubric labels + cell values. */
  rubric?: Record<string, { value: string; passed: boolean | null }>
  identityResolutionStatus?: string
  normalizationStatus?: string
  /** Most-recent evaluation tier + 1-line explanation when present. */
  evaluation?: {
    tier?: string
    score?: number
    explanation?: string
  }
}

export interface ListBatchCandidatesResult {
  ok: true
  batchId: string
  rows: BatchCandidateRow[]
  jobId?: string
  companyId?: string
}

interface CandidateRecordDoc {
  recordId?: string
  batchId?: string
  name?: string
  canonicalLinkedInUrl?: string
  currentTitle?: string
  currentCompany?: string
  location?: string
  emails?: Array<{ value?: string }>
  identityResolutionStatus?: string
  normalizationStatus?: string
  resolvedCandidateId?: string
  enrichment?: {
    rubric?: Record<string, { value: string; passed: boolean | null }>
    matchScore?: string
    headline?: string
  }
}

interface BatchDoc {
  batchId?: string
  jobId?: string
  companyId?: string
}

interface EvaluationDoc {
  proposedTier?: string
  generalRubricScore?: number
  explanation?: string
}

async function loadLatestEvaluationForCandidate(
  db: Firestore,
  candidateId: string,
  jobId: string | undefined,
): Promise<EvaluationDoc | null> {
  if (!candidateId || !jobId) return null
  const snap = await db
    .collection(PA_COLLECTIONS.candidateCompanyJobEvaluations)
    .where("candidateId", "==", candidateId)
    .where("jobId", "==", jobId)
    .orderBy("createdAt", "desc")
    .limit(1)
    .get()
    .catch(() => null)
  if (!snap || snap.empty) return null
  return snap.docs[0]!.data() as EvaluationDoc
}

async function loadResolvedCandidateId(
  db: Firestore,
  recordId: string,
  record: CandidateRecordDoc,
): Promise<string | undefined> {
  if (record.resolvedCandidateId) return record.resolvedCandidateId
  const snap = await db
    .collection(PA_COLLECTIONS.candidateSourceLinks)
    .where("externalRecordId", "==", recordId)
    .limit(1)
    .get()
    .catch(() => null)
  if (!snap || snap.empty) return undefined
  return (snap.docs[0]!.data() as { candidateId?: string }).candidateId
}

export async function runListBatchCandidates(
  rawInput: unknown,
  auth: Parameters<typeof requireExternalSupplyAdmin>[0] | undefined,
  db: Firestore,
): Promise<ListBatchCandidatesResult> {
  requireExternalSupplyAdmin(auth)
  const parsed = ListBatchCandidatesInputSchema.safeParse(rawInput)
  if (!parsed.success) {
    throw new HttpsError("invalid-argument", parsed.error.message)
  }
  const { batchId } = parsed.data

  const batchSnap = await db
    .collection(PA_COLLECTIONS.externalSourcingBatches)
    .doc(batchId)
    .get()
  const batchData = batchSnap.exists ? (batchSnap.data() as BatchDoc) : {}

  const recordsSnap = await db
    .collection(PA_COLLECTIONS.externalCandidateRecords)
    .where("batchId", "==", batchId)
    .limit(500)
    .get()

  // 1. Bulk identity-resolution lookup — replace per-row N+1 `where externalRecordId ==`
  //    with one `where in (...)` chunked at 10 (Firestore limit). 49 rows used
  //    to fire 49 queries + 49 evaluations + filled memory; now 5 + 1 = 6.
  const recordIds = recordsSnap.docs.map((d) => {
    const r = d.data() as CandidateRecordDoc
    return r.recordId ?? d.id
  })
  const candidateIdByRecord = new Map<string, string>()
  // Records may already carry `resolvedCandidateId` — short-circuit before
  // the network call.
  const recordsNeedingResolve: string[] = []
  for (let i = 0; i < recordsSnap.docs.length; i += 1) {
    const r = recordsSnap.docs[i]!.data() as CandidateRecordDoc
    const recordId = recordIds[i]!
    if (r.resolvedCandidateId) {
      candidateIdByRecord.set(recordId, r.resolvedCandidateId)
    } else {
      recordsNeedingResolve.push(recordId)
    }
  }
  for (let i = 0; i < recordsNeedingResolve.length; i += 10) {
    const chunk = recordsNeedingResolve.slice(i, i + 10)
    const snap = await db
      .collection(PA_COLLECTIONS.candidateSourceLinks)
      .where("externalRecordId", "in", chunk)
      .get()
      .catch(() => null)
    if (!snap) continue
    for (const d of snap.docs) {
      const data = d.data() as { candidateId?: string; externalRecordId?: string }
      if (data.candidateId && data.externalRecordId) {
        candidateIdByRecord.set(data.externalRecordId, data.candidateId)
      }
    }
  }

  // 2. Bulk evaluation lookup — `where candidateId in (...) and jobId == X`
  //    in chunks of 10, only when the batch has a bound job.
  const evaluationByCandidate = new Map<string, EvaluationDoc>()
  if (batchData.jobId && candidateIdByRecord.size > 0) {
    const ids = [...new Set(candidateIdByRecord.values())]
    for (let i = 0; i < ids.length; i += 10) {
      const chunk = ids.slice(i, i + 10)
      const snap = await db
        .collection(PA_COLLECTIONS.candidateCompanyJobEvaluations)
        .where("candidateId", "in", chunk)
        .where("jobId", "==", batchData.jobId)
        .get()
        .catch(() => null)
      if (!snap) continue
      // Pick most recent per candidate.
      for (const d of snap.docs) {
        const data = d.data() as EvaluationDoc & { candidateId?: string; createdAt?: string }
        if (!data.candidateId) continue
        const existing = evaluationByCandidate.get(data.candidateId) as
          | (EvaluationDoc & { createdAt?: string })
          | undefined
        if (!existing || (data.createdAt ?? "") > (existing.createdAt ?? "")) {
          evaluationByCandidate.set(data.candidateId, data)
        }
      }
    }
  }

  const rows: BatchCandidateRow[] = []
  for (let i = 0; i < recordsSnap.docs.length; i += 1) {
    const doc = recordsSnap.docs[i]!
    const r = doc.data() as CandidateRecordDoc
    const recordId = recordIds[i]!
    const candidateId = candidateIdByRecord.get(recordId)
    const evaluation = candidateId ? evaluationByCandidate.get(candidateId) ?? null : null
    const row: BatchCandidateRow = {
      recordId,
      batchId,
    }
    if (candidateId) row.candidateId = candidateId
    if (r.name) row.name = r.name
    if (r.canonicalLinkedInUrl) row.linkedinUrl = r.canonicalLinkedInUrl
    if (r.currentTitle) row.currentTitle = r.currentTitle
    if (r.currentCompany) row.currentCompany = r.currentCompany
    if (r.location) row.location = r.location
    if (r.emails && r.emails[0]?.value) row.email = r.emails[0]!.value
    if (r.identityResolutionStatus) row.identityResolutionStatus = r.identityResolutionStatus
    if (r.normalizationStatus) row.normalizationStatus = r.normalizationStatus
    const enrichment = r.enrichment ?? {}
    if (enrichment.rubric) row.rubric = enrichment.rubric
    if (enrichment.matchScore) row.matchScore = enrichment.matchScore
    if (enrichment.headline) row.headline = enrichment.headline
    if (evaluation) {
      const ev: BatchCandidateRow["evaluation"] = {}
      if (evaluation.proposedTier) ev.tier = evaluation.proposedTier
      if (typeof evaluation.generalRubricScore === "number") ev.score = evaluation.generalRubricScore
      if (evaluation.explanation) ev.explanation = evaluation.explanation
      row.evaluation = ev
    }
    rows.push(row)
  }

  // Sort: rows with a numeric matchScore desc, then evaluation score desc,
  // then name asc. Determinism keeps the list stable across reloads.
  rows.sort((a, b) => {
    const ma = parseFloat(a.matchScore ?? "")
    const mb = parseFloat(b.matchScore ?? "")
    const maOk = Number.isFinite(ma)
    const mbOk = Number.isFinite(mb)
    if (maOk && mbOk && ma !== mb) return mb - ma
    if (maOk && !mbOk) return -1
    if (!maOk && mbOk) return 1
    const ea = a.evaluation?.score ?? -1
    const eb = b.evaluation?.score ?? -1
    if (ea !== eb) return eb - ea
    return (a.name ?? "").localeCompare(b.name ?? "")
  })

  const result: ListBatchCandidatesResult = { ok: true, batchId, rows }
  if (batchData.jobId) result.jobId = batchData.jobId
  if (batchData.companyId) result.companyId = batchData.companyId
  return result
}

export const paExternalSupplyListBatchCandidates = onCall(
  {
    region: "us-central1",
    // 512 MiB — 256 OOMed on a 49-row batch with rubric blobs + per-row joins.
    // Combined with the N+1 → bulk `where in` refactor below 512 is safe up to
    // the 500-record limit() cap.
    memory: "512MiB",
    timeoutSeconds: 60,
  },
  async (req): Promise<ListBatchCandidatesResult> => {
    return runListBatchCandidates(req.data, req.auth, getFirestore())
  },
)

// ---------------------------------------------------------------------------
// Candidate detail (drawer)
// ---------------------------------------------------------------------------

const GetCandidateDetailInputSchema = z.object({
  recordId: z.string().min(1),
})

export interface CandidateDetail {
  recordId: string
  batchId: string
  candidateId?: string
  record: CandidateRecordDoc
  candidate?: Record<string, unknown>
  resume?: {
    artifactId: string
    candidateProfileSummary?: string
    storagePath?: string
    parsedCandidateResumeId?: string
  }
  evaluation?: EvaluationDoc & { evaluationId: string }
  handles?: Array<{ kind: string; redactedValue: string }>
}

function redactHandle(kind: string, raw: string | undefined): string {
  if (!raw) return ""
  if (kind === "email") {
    const [local, domain] = raw.split("@")
    if (!local || !domain) return raw
    return `${local.slice(0, 2)}***@${domain}`
  }
  if (kind === "phone") return `***${raw.slice(-4)}`
  if (kind === "linkedin") {
    // Already a URL — show only the slug tail.
    const m = /\/in\/([^/]+)/.exec(raw)
    return m ? `linkedin.com/in/${m[1]}` : raw
  }
  return raw
}

export async function runGetCandidateDetail(
  rawInput: unknown,
  auth: Parameters<typeof requireExternalSupplyAdmin>[0] | undefined,
  db: Firestore,
): Promise<CandidateDetail> {
  requireExternalSupplyAdmin(auth)
  const parsed = GetCandidateDetailInputSchema.safeParse(rawInput)
  if (!parsed.success) {
    throw new HttpsError("invalid-argument", parsed.error.message)
  }
  const { recordId } = parsed.data

  const recSnap = await db
    .collection(PA_COLLECTIONS.externalCandidateRecords)
    .doc(recordId)
    .get()
  if (!recSnap.exists) throw new HttpsError("not-found", `record_not_found:${recordId}`)
  const record = recSnap.data() as CandidateRecordDoc
  const batchId = record.batchId ?? ""

  const candidateId = await loadResolvedCandidateId(db, recordId, record)

  let candidate: Record<string, unknown> | undefined
  let resume: CandidateDetail["resume"] | undefined
  let evaluation: CandidateDetail["evaluation"] | undefined
  const handles: CandidateDetail["handles"] = []

  if (candidateId) {
    const userSnap = await db.collection(PA_COLLECTIONS.users).doc(candidateId).get()
    if (userSnap.exists) candidate = userSnap.data() as Record<string, unknown>

    const resumeSnap = await db
      .collection(PA_COLLECTIONS.resumeArtifacts)
      .where("candidateId", "==", candidateId)
      .orderBy("createdAt", "desc")
      .limit(1)
      .get()
      .catch(() => null)
    if (resumeSnap && !resumeSnap.empty) {
      const r = resumeSnap.docs[0]!
      const data = r.data() as {
        candidateProfileSummary?: string
        storagePath?: string
        parsedCandidateResumeId?: string
      }
      resume = {
        artifactId: r.id,
        ...(data.candidateProfileSummary ? { candidateProfileSummary: data.candidateProfileSummary } : {}),
        ...(data.storagePath ? { storagePath: data.storagePath } : {}),
        ...(data.parsedCandidateResumeId
          ? { parsedCandidateResumeId: data.parsedCandidateResumeId }
          : {}),
      }
    }

    const batchSnap = await db
      .collection(PA_COLLECTIONS.externalSourcingBatches)
      .doc(batchId)
      .get()
    const jobId = batchSnap.exists ? (batchSnap.data() as BatchDoc).jobId : undefined
    if (jobId) {
      const evalSnap = await db
        .collection(PA_COLLECTIONS.candidateCompanyJobEvaluations)
        .where("candidateId", "==", candidateId)
        .where("jobId", "==", jobId)
        .orderBy("createdAt", "desc")
        .limit(1)
        .get()
        .catch(() => null)
      if (evalSnap && !evalSnap.empty) {
        const e = evalSnap.docs[0]!
        evaluation = { evaluationId: e.id, ...(e.data() as EvaluationDoc) }
      }
    }

    const handlesSnap = await db
      .collection(PA_COLLECTIONS.candidateHandles)
      .where("candidateId", "==", candidateId)
      .limit(8)
      .get()
      .catch(() => null)
    if (handlesSnap && !handlesSnap.empty) {
      for (const h of handlesSnap.docs) {
        const d = h.data() as { kind?: string; rawValue?: string; normalizedValue?: string }
        const kind = d.kind ?? "unknown"
        const raw = d.normalizedValue ?? d.rawValue ?? ""
        handles.push({ kind, redactedValue: redactHandle(kind, raw) })
      }
    }
  }

  const detail: CandidateDetail = {
    recordId,
    batchId,
    record,
  }
  if (candidateId) detail.candidateId = candidateId
  if (candidate) detail.candidate = candidate
  if (resume) detail.resume = resume
  if (evaluation) detail.evaluation = evaluation
  if (handles.length > 0) detail.handles = handles
  return detail
}

export const paExternalSupplyGetCandidateDetail = onCall(
  {
    region: "us-central1",
    memory: "256MiB",
    timeoutSeconds: 60,
  },
  async (req): Promise<CandidateDetail> => {
    return runGetCandidateDetail(req.data, req.auth, getFirestore())
  },
)
