/**
 * employer-passed-candidates.ts — `paEmployerPassedCandidates` +
 * `paEmployerPassedCandidateIntroDecision` public onCalls.
 *
 * Phase 4 LIVE PASSED INBOX. Replaces the hardcoded sample inbox in
 * apps/pa-landing/src/pages/Employers.tsx with a REAL read of
 * pa-employer-visible-profiles — scoped to the employer's OWN pilot reqs only,
 * consent-gated, and PII-redacted exactly like the admin snapshot path.
 *
 * Scoping key = the onboarding requester's normalized work email
 * (createdByEmail stamped on the employer's pa-jobs reqs by
 * paEmployerCreatePilotReq). There is no real employer auth on this public flow
 * yet, so the email is SELF-ASSERTED — these callables therefore expose ONLY:
 *   (1) passed-only snapshots (createdFromState === "passed"), and
 *   (2) for jobIds the employer demonstrably owns (createdByEmail match), and
 *   (3) redacted of all raw contact PII (reuses runAdminPassedCandidatesSnapshot's
 *       redaction + consent gate; the stored snapshot is already redaction-clean
 *       per EmployerVisibleProfileSchema's superRefine).
 * No candidate emails / phones / LinkedIn / resume URLs ever cross this
 * boundary, and an employer can only ever see candidates passed for their own
 * reqs (CLAUDE.md v2.0 Product Rule #6 — employer dashboard is passed-only).
 *
 * The intro-decision wrapper reuses runAdminPassedCandidateIntroDecision but
 * (a) verifies the snapshot's jobId is in the employer's req set BEFORE acting,
 * and (b) stamps actor:"employer" / decidedBy:<employer email> so the emitted
 * employer_intro_accepted/rejected FSM + FeedbackEvent are attributed to the
 * hiring team, feeding the flywheel.
 *
 * AUTH: public — mirrors paEmployerMatchPilotReq (cors:true, no auth/app-check).
 * We deliberately do NOT reuse the admin-token-gated callables on the public
 * site; ownership is enforced by the createdByEmail req-set check instead.
 */
import { onCall, HttpsError } from "firebase-functions/v2/https"
import { logger } from "firebase-functions/v2"
import { getFirestore, type Firestore } from "firebase-admin/firestore"
import { PA_COLLECTIONS } from "@pa/core-types"
import { normalizeEmployerEmail } from "./employer-create-pilot-req.js"
import {
  runAdminPassedCandidatesSnapshot,
  runAdminPassedCandidateIntroDecision,
  type PassedCandidateRow,
  type AdminPassedCandidateIntroDecisionResult,
} from "./admin-passed-candidates.js"

// ---- Shared: resolve the employer's owned reqId set -------------------------

/**
 * Return the set of jobIds (= reqIds) owned by this employer email, read from
 * pa-jobs where createdByEmail == email. Empty set means "no reqs / unknown
 * employer" → the inbox is empty and every intro decision is rejected.
 */
async function loadEmployerReqIds(db: Firestore, employerEmail: string): Promise<Set<string>> {
  const snap = await db
    .collection(PA_COLLECTIONS.jobs)
    .where("createdByEmail", "==", employerEmail)
    .where("source", "==", "employer_onboarding")
    .limit(200)
    .get()
  const ids = new Set<string>()
  for (const doc of snap.docs) {
    const d = doc.data() as Record<string, unknown>
    const jobId = typeof d.jobId === "string" && d.jobId ? d.jobId : doc.id
    if (jobId) ids.add(jobId)
  }
  return ids
}

// ---- paEmployerPassedCandidates ---------------------------------------------

export type EmployerPassedCandidatesInput = {
  employerEmail: string
  /** Optional — restrict to one of the employer's reqs. Default: all of them. */
  jobId?: string
  /** Hide rows whose PII consent is missing. Default true (employer-safe). */
  requireConsent?: boolean
}

export type EmployerPassedCandidatesOutput = {
  employerEmail: string
  reqCount: number
  summary: {
    totalPassed: number
    withConsent: number
    missingConsent: number
    hiddenMissingConsent: number
  }
  rows: PassedCandidateRow[]
}

export async function runEmployerPassedCandidates(
  raw: unknown,
  deps: { db: Firestore; now?: () => string },
): Promise<EmployerPassedCandidatesOutput> {
  const data = (raw ?? {}) as Partial<EmployerPassedCandidatesInput>
  const employerEmail = normalizeEmployerEmail(data.employerEmail)
  if (!employerEmail) {
    throw new HttpsError("invalid-argument", "A valid employer email is required.")
  }
  // SECURITY (locked rules a + g): consent is SERVER-ENFORCED on this PUBLIC,
  // self-asserted-email surface. A caller-supplied `requireConsent:false` must
  // NOT be able to reveal non-consented passed candidates — the flag is ignored
  // for row visibility. The summary still reports the missing-consent COUNT so
  // the employer sees "N pending consent", but never their data.
  const reqIds = await loadEmployerReqIds(deps.db, employerEmail)

  // If a specific jobId is requested it MUST be in the employer's req set.
  const requestedJobId = typeof data.jobId === "string" ? data.jobId.trim() : ""
  let targetJobIds: string[]
  if (requestedJobId) {
    if (!reqIds.has(requestedJobId)) {
      // Don't leak whether the job exists — just return an empty inbox.
      return {
        employerEmail,
        reqCount: reqIds.size,
        summary: { totalPassed: 0, withConsent: 0, missingConsent: 0, hiddenMissingConsent: 0 },
        rows: [],
      }
    }
    targetJobIds = [requestedJobId]
  } else {
    targetJobIds = [...reqIds]
  }

  // Run the SAME pure snapshot runner per owned jobId, flatten the rows. The
  // runner already validates createdFromState === "passed", cross-checks the
  // candidate-job state, redacts PII, and computes consentStatus.
  const allRows: PassedCandidateRow[] = []
  let withConsent = 0
  let missingConsent = 0
  for (const jobId of targetJobIds) {
    const snap = await runAdminPassedCandidatesSnapshot(
      { jobId, limit: 100 },
      { db: deps.db, ...(deps.now ? { now: deps.now } : {}) },
    )
    for (const row of snap.rows) {
      if (row.profile.consentStatus === "granted") withConsent += 1
      else missingConsent += 1
    }
    allRows.push(...snap.rows)
  }

  // Always granted-only — non-overridable (see SECURITY note above).
  const visibleRows = allRows.filter((r) => r.profile.consentStatus === "granted")
  const hiddenMissingConsent = missingConsent

  visibleRows.sort((a, b) => b.createdAt.localeCompare(a.createdAt))

  logger.info("paEmployerPassedCandidates.read", {
    reqCount: reqIds.size,
    targetJobs: targetJobIds.length,
    totalPassed: allRows.length,
    visible: visibleRows.length,
    consentEnforced: true,
  })

  return {
    employerEmail,
    reqCount: reqIds.size,
    summary: {
      totalPassed: allRows.length,
      withConsent,
      missingConsent,
      hiddenMissingConsent,
    },
    rows: visibleRows,
  }
}

export const paEmployerPassedCandidates = onCall<EmployerPassedCandidatesInput>(
  // 512MiB — runAdminPassedCandidatesSnapshot fans out reads per job.
  { region: "us-central1", cors: true, memory: "512MiB", timeoutSeconds: 120 },
  async (req): Promise<EmployerPassedCandidatesOutput> =>
    runEmployerPassedCandidates(req.data, { db: getFirestore() }),
)

// ---- paEmployerPassedCandidateIntroDecision ---------------------------------

export type EmployerPassedCandidateIntroDecisionInput = {
  employerEmail: string
  snapshotId: string
  decision: "accepted" | "rejected"
  reason: string
}

export async function runEmployerPassedCandidateIntroDecision(
  raw: unknown,
  deps: { db: Firestore; now?: () => string },
): Promise<AdminPassedCandidateIntroDecisionResult> {
  const data = (raw ?? {}) as Partial<EmployerPassedCandidateIntroDecisionInput>
  const employerEmail = normalizeEmployerEmail(data.employerEmail)
  if (!employerEmail) {
    throw new HttpsError("invalid-argument", "A valid employer email is required.")
  }

  const reqIds = await loadEmployerReqIds(deps.db, employerEmail)
  if (reqIds.size === 0) {
    throw new HttpsError("permission-denied", "No pilot reqs found for this employer.")
  }

  return runAdminPassedCandidateIntroDecision(
    {
      snapshotId: data.snapshotId,
      decision: data.decision,
      reason: data.reason,
    },
    {
      db: deps.db,
      ...(deps.now ? { now: deps.now } : {}),
      actor: "employer",
      actorEmail: employerEmail,
      // Enforce ownership: the snapshot's jobId must be one of THIS employer's
      // reqs. Reject before any FSM write otherwise.
      authorizeSnapshot: async (snapshotId: string) => {
        const snap = await deps.db
          .collection(PA_COLLECTIONS.employerVisibleProfiles)
          .doc(snapshotId)
          .get()
        if (!snap.exists) {
          throw new HttpsError("not-found", "Passed profile not found.")
        }
        const jobId = (snap.data() as Record<string, unknown>)?.jobId
        if (typeof jobId !== "string" || !reqIds.has(jobId)) {
          throw new HttpsError("permission-denied", "This passed profile is not for one of your reqs.")
        }
      },
    },
  )
}

export const paEmployerPassedCandidateIntroDecision = onCall<EmployerPassedCandidateIntroDecisionInput>(
  { region: "us-central1", cors: true, memory: "256MiB", timeoutSeconds: 60 },
  async (req): Promise<AdminPassedCandidateIntroDecisionResult> =>
    runEmployerPassedCandidateIntroDecision(req.data, { db: getFirestore() }),
)
