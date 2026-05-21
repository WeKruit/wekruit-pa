/**
 * P2.5 — Mirror CoreSignal v2 collect experience[] into the canonical
 * `parsedCandidateResumes/{auto-id}` collection so all downstream surfaces
 * (Claire cv-analysis, paReverseMatch, job-rec-daily, dashboard CandidateProfile)
 * can see CoreSignal-sourced candidates.
 *
 * Without this mirror, CoreSignal data lives only in
 * `pa-external-candidate-records.experience[]` which the rubric evaluator
 * reads — but the rest of the system queries `parsedCandidateResumes`. P2
 * already filled `pa-users.tags.skills`, but tag-level fields aren't enough
 * for surfaces that walk per-experience work history.
 *
 * Also records `coresignalEmployeeId` on the `pa-users` doc as a stable
 * external identity handle so subsequent fetches of the same CoreSignal id
 * for an already-linked candidate are de-duplicated cheaply (vs full
 * linkedin-url canonicalization roundtrip).
 *
 * Idempotency: skip mirror if a parsedCandidateResumes doc with
 * `source: "coresignal_collect_v2"` AND same `coresignalEmployeeId` already
 * exists for this userId. CoreSignal data is stable per id — duplicate
 * mirrors waste storage and confuse the cv-context-injection ordering.
 */
import type { Firestore } from "firebase-admin/firestore"
import type { ExternalCandidateRecord } from "@pa/core-types"

const PARSED_RESUMES_COLLECTION = "parsedCandidateResumes"
const PA_USERS_COLLECTION = "pa-users"

export interface CoresignalExperiencesMirrorResult {
  status:
    | "mirrored"
    | "skipped_not_coresignal"
    | "skipped_no_experience"
    | "skipped_already_mirrored"
    | "skipped_no_coresignal_id"
}

/**
 * Read CoreSignal employee id from the external candidate record's rawPayload.
 * The CoreSignal cdapi v2 collect response has `id: <number>` at root.
 */
function extractCoresignalEmployeeId(record: ExternalCandidateRecord): number | null {
  const raw = record.rawPayload as Record<string, unknown> | undefined
  if (!raw) return null
  const id = raw.id
  if (typeof id === "number" && Number.isInteger(id) && id > 0) return id
  // Defensive: coresignal sometimes stringifies
  if (typeof id === "string") {
    const parsed = Number.parseInt(id, 10)
    if (Number.isInteger(parsed) && parsed > 0) return parsed
  }
  return null
}

/**
 * Translate ExternalCandidateRecord into a parsedCandidateResumes baseDoc
 * shape. Mirrors the canonical write site in
 * `apps/functions/src/cv-ingest/cv-ingest.ts` minus PDF-specific fields
 * (mediaUrl, fileType, sha256) which don't apply to LinkedIn-sourced data.
 */
export function buildParsedResumeDocFromRecord(
  record: ExternalCandidateRecord,
  userId: string,
  nowIso: string,
  coresignalEmployeeId: number,
): Record<string, unknown> {
  const experiences = (record.experience ?? []).map((e) => ({
    title: e.title,
    company: e.company,
    startDate: e.startDate ?? null,
    endDate: e.endDate ?? null,
    durationMonths: e.durationMonths ?? null,
  }))
  const education = (record.education ?? []).map((e) => ({
    school: e.school,
    degree: e.degree ?? null,
    field: e.field ?? null,
    endYear: e.endYear ?? null,
  }))
  // sourceTags = inferred + historical skills (dedup'd in adapter).
  const skills = record.sourceTags ?? []
  const topSkills = skills.slice(0, 12)
  return {
    userId,
    candidateProfile: {
      name: record.name ?? null,
      skills,
    },
    experiences,
    education,
    industryTags: [], // Adam directive: derive later via job-tag enricher
    topSkills,
    originalFileName: null,
    fileType: null,
    studentFrom: null,
    sessionId: null,
    mediaUrl: null,
    ingestedAt: nowIso,
    ingestedVia: "coresignal_collect_v2",
    createdAt: new Date(nowIso),
    parserVersion: "coresignal_collect_v2",
    // P2.5 — explicit external identity for dedup.
    source: "coresignal_collect_v2",
    coresignalEmployeeId,
    // External-source link back to the record + batch for audit.
    sourceRecordId: record.recordId,
    sourceBatchId: record.batchId,
  }
}

export interface MirrorDeps {
  /** Query existing parsedCandidateResumes rows for this user. */
  findExistingForUser?: (userId: string) => Promise<Array<{ coresignalEmployeeId?: number; source?: string }>>
  /** Write the parsedCandidateResumes doc + the pa-users.coresignalEmployeeId field. */
  writeBoth?: (args: {
    parsedResumeDoc: Record<string, unknown>
    userId: string
    coresignalEmployeeId: number
  }) => Promise<void>
  now?: () => string
  log?: (event: string, fields?: Record<string, unknown>) => void
}

/**
 * Pure runner — deps-injected for tests. Default Firestore wrapper below.
 */
export async function runCoresignalExperiencesMirror(
  record: ExternalCandidateRecord,
  userId: string,
  deps: MirrorDeps,
): Promise<CoresignalExperiencesMirrorResult> {
  const now = (deps.now ?? (() => new Date().toISOString()))()

  if (record.source !== "coresignal_collect_v2") {
    return { status: "skipped_not_coresignal" }
  }
  if (!record.experience || record.experience.length === 0) {
    return { status: "skipped_no_experience" }
  }
  const coresignalEmployeeId = extractCoresignalEmployeeId(record)
  if (coresignalEmployeeId === null) {
    deps.log?.("coresignal_mirror.no_id_in_raw_payload", {
      recordId: record.recordId,
    })
    return { status: "skipped_no_coresignal_id" }
  }

  if (deps.findExistingForUser) {
    const existing = await deps.findExistingForUser(userId)
    const dupe = existing.some(
      (r) =>
        r.source === "coresignal_collect_v2" &&
        r.coresignalEmployeeId === coresignalEmployeeId,
    )
    if (dupe) {
      return { status: "skipped_already_mirrored" }
    }
  }

  const doc = buildParsedResumeDocFromRecord(record, userId, now, coresignalEmployeeId)

  if (deps.writeBoth) {
    await deps.writeBoth({
      parsedResumeDoc: doc,
      userId,
      coresignalEmployeeId,
    })
  }

  deps.log?.("coresignal_mirror.ok", {
    userId,
    coresignalEmployeeId,
    experienceCount: (doc.experiences as unknown[]).length,
  })

  return { status: "mirrored" }
}

// ---------------------------------------------------------------------------
// Default Firestore deps wrapper
// ---------------------------------------------------------------------------

export function makeFirestoreMirrorDeps(db: Firestore): Pick<MirrorDeps, "findExistingForUser" | "writeBoth"> {
  return {
    findExistingForUser: async (userId: string) => {
      const snap = await db
        .collection(PARSED_RESUMES_COLLECTION)
        .where("userId", "==", userId)
        .where("source", "==", "coresignal_collect_v2")
        .limit(10)
        .get()
      return snap.docs.map((d) => {
        const data = d.data() as Record<string, unknown>
        return {
          coresignalEmployeeId:
            typeof data.coresignalEmployeeId === "number" ? data.coresignalEmployeeId : undefined,
          source: typeof data.source === "string" ? data.source : undefined,
        }
      })
    },
    writeBoth: async ({ parsedResumeDoc, userId, coresignalEmployeeId }) => {
      const batch = db.batch()
      const newRef = db.collection(PARSED_RESUMES_COLLECTION).doc()
      batch.set(newRef, parsedResumeDoc)
      batch.set(
        db.collection(PA_USERS_COLLECTION).doc(userId),
        {
          coresignalEmployeeId,
          coresignalEmployeeIdUpdatedAt: new Date().toISOString(),
        },
        { merge: true },
      )
      await batch.commit()
    },
  }
}
