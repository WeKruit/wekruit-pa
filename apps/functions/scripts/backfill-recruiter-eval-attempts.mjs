/**
 * Backfill migration — mirror EXISTING recruiter submissions into the canonical
 * eval store so they are labelable through the shared dual-pane <EvalLabelForm>.
 *
 * The `paRecruiterSubmissionEval` trigger now (P3, 2026-06-15) upserts a
 * `pa-evaluation-attempts/{attemptId}` doc alongside the submission's
 * `aiEvaluation`. Submissions evaluated BEFORE that shipped have an
 * `aiEvaluation` but no mirrored attempt (and no `evaluationAttemptId` stamp on
 * the submission). This walks every `pa-recruiter-submissions` doc that carries
 * an `aiEvaluation`, builds the attempt via the SAME pure mapping the trigger
 * uses (`recruiterSubmissionToEvaluationAttempt`), and writes the missing
 * attempts + stamps `evaluationAttemptId` back onto the submission.
 *
 * ADDITIVE + idempotent: reads any existing attempt and PRESERVES its
 * `humanReview` (including a human gold label). Never touches submission
 * `status`. Never messages anyone.
 *
 * Env: FIREBASE_SERVICE_ACCOUNT_JSON. Run from apps/functions.
 * Flags:
 *   (default)        DRY-RUN — reports what it would write, writes nothing.
 *   --apply          Actually write the missing attempts + stamp submissions.
 *   --force          Re-mirror even submissions already carrying an attempt
 *                    (still preserves humanReview).
 *   --limit=N        Cap submissions scanned (default 5000).
 *
 * Run command (from apps/functions, with prod creds in env):
 *   node scripts/backfill-recruiter-eval-attempts.mjs            # dry-run
 *   node scripts/backfill-recruiter-eval-attempts.mjs --apply    # write
 */
import { initializeApp, cert } from "firebase-admin/app"
import { getFirestore } from "firebase-admin/firestore"

const argv = process.argv.slice(2)
const APPLY = argv.includes("--apply")
const FORCE = argv.includes("--force")
const LIMIT = Number((argv.find((a) => a.startsWith("--limit=")) || "").split("=")[1]) || 5000

const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)
initializeApp({ credential: cert(sa) })
const db = getFirestore()

const { createEvaluationAttemptId } = await import("@pa/core-types")
const { getEvaluationAttempt, saveEvaluationAttempt } = await import("@pa/pa-persistence")
const { recruiterSubmissionToEvaluationAttempt } = await import("../src/recruiter-submission-eval.ts")

const SUBMISSIONS = "pa-recruiter-submissions"

const nowIso = () => new Date().toISOString()

const snap = await db.collection(SUBMISSIONS).limit(LIMIT).get()
console.log(
  `scanned ${snap.size} recruiter submissions (apply=${APPLY}, force=${FORCE}, limit=${LIMIT})`,
)

const counts = {
  no_aiEvaluation: 0,
  no_jobId: 0,
  already_mirrored: 0,
  would_write: 0,
  written: 0,
  preserved_label: 0,
  error: 0,
}

for (const doc of snap.docs) {
  const submissionId = doc.id
  const submission = doc.data() ?? {}
  const aiEvaluation = submission.aiEvaluation
  if (!aiEvaluation || typeof aiEvaluation !== "object") {
    counts.no_aiEvaluation++
    continue
  }
  const jobId = typeof submission.jobId === "string" ? submission.jobId.trim() : ""
  if (!jobId) {
    counts.no_jobId++
    console.warn(`  ! ${submissionId}: aiEvaluation present but no jobId — skipping`)
    continue
  }

  try {
    const attemptId = createEvaluationAttemptId({
      source: "recruiter_submission",
      jobId,
      salt: submissionId,
    })
    const existing = await getEvaluationAttempt(db, attemptId)
    const stamped = submission.evaluationAttemptId === attemptId
    if (existing && stamped && !FORCE) {
      counts.already_mirrored++
      continue
    }

    const candidateId =
      typeof submission.candidateId === "string" && submission.candidateId.trim()
        ? submission.candidateId.trim()
        : undefined
    const companyId =
      typeof submission.companyId === "string" && submission.companyId.trim()
        ? submission.companyId.trim()
        : undefined

    const attempt = recruiterSubmissionToEvaluationAttempt({
      submissionId,
      jobId,
      candidateId,
      companyId,
      aiEvaluation,
      nowIso: nowIso(),
      existing,
    })
    if (existing?.humanReview?.label) counts.preserved_label++

    if (!APPLY) {
      counts.would_write++
      if (counts.would_write <= 20) {
        console.log(
          `  would write ${attemptId} ← ${submissionId} (verdict=${aiEvaluation.verdict}, label=${Boolean(existing?.humanReview?.label)})`,
        )
      }
      continue
    }

    await saveEvaluationAttempt(db, attempt)
    await db.collection(SUBMISSIONS).doc(submissionId).set({ evaluationAttemptId: attemptId }, { merge: true })
    counts.written++
    if (counts.written % 25 === 0) console.log(`  ...written ${counts.written}`)
  } catch (err) {
    counts.error++
    console.error(`  EXC ${submissionId}:`, err?.message ?? err)
  }
}

console.log(`DONE | ${JSON.stringify(counts)}`)
process.exit(0)
