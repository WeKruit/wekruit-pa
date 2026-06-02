/**
 * hitl-to-scheduling-harness.ts
 *
 * PROVES the HITL-commit -> scheduling linkage for thin Claire against REAL
 * Firestore, scoped STRICTLY to Adam's dev uid (8fEwIduUrzxZsblHHsNz) + a single
 * clearly-marked TEST job. It drives the SAME production code the dashboard
 * "approve" button + the offer_interview_slots tool run — no re-implementation:
 *
 *   - runReviewEvaluationAttempt  (the body of callable paReviewEvaluationAttempt)
 *   - markPrescreenTerminalOutcome -> applyPassedCandidateSnapshot (HITL commit)
 *   - listSchedulableJobs          (the query behind offer_interview_slots)
 *
 * What it asserts:
 *   1. terminalActionPendingReview flips true -> false on the seeded session.
 *   2. pa-employer-visible-profiles/{jobId}__{candidateId} now EXISTS.
 *   3. pa-candidate-job-states.{state} == "employer_visible".
 *   4. listSchedulableJobs(Adam) returns the TEST job (distinct from dev-mimic).
 *
 * SAFETY (default = DRY/SAFE):
 *   - Writes ONLY to docs keyed on ADAM_UID + the TEST_JOB_ID. Never other users.
 *   - NO real Sendblue SMS: sendSms is stubbed unless --send-sms is passed.
 *   - Idempotent: deterministic doc ids, merge-safe seeds.
 *   - --cleanup deletes every seeded doc so prod isn't polluted.
 *
 * USAGE (run from repo root; Node 24):
 *   source ~/.zshrc && nvm use 24
 *   export GOOGLE_APPLICATION_CREDENTIALS=$(mktemp) && \
 *     grep -E "^FIREBASE_SERVICE_ACCOUNT_JSON=" .env \
 *       | sed 's/^FIREBASE_SERVICE_ACCOUNT_JSON=//' > "$GOOGLE_APPLICATION_CREDENTIALS"
 *   # default DRY run (seed + commit + assert + scheduling check, NO real SMS):
 *   node --import tsx apps/functions/scripts/hitl-to-scheduling-harness.ts
 *   # tear down the seeded test docs:
 *   node --import tsx apps/functions/scripts/hitl-to-scheduling-harness.ts --cleanup
 *   # (rare) let the real decision SMS fire to Adam's dev phone:
 *   node --import tsx apps/functions/scripts/hitl-to-scheduling-harness.ts --send-sms
 */
import { initializeApp, applicationDefault, getApps } from "firebase-admin/app"
import { getFirestore, type Firestore } from "firebase-admin/firestore"
import {
  PA_COLLECTIONS,
  createCandidateJobStateId,
  createCandidateJobMatchId,
  createEmployerVisibleProfileId,
  createEvaluationAttemptId,
  interviewBookingDocId,
  type EvaluationAttempt,
} from "@pa/core-types"
import { runReviewEvaluationAttempt } from "../src/evaluation-attempts.js"
import {
  markFirstInterviewStarted,
  markPrescreenReviewPending,
} from "../src/prescreen-outcome-service.js"
import {
  listSchedulableJobs,
  SCHEDULING_DEV_UIDS,
} from "../src/claire-agent/tools/scheduling-tools.js"
import type { ClaireToolContext } from "../src/claire-agent/types.js"

// ── Hard-scoped identifiers. ALL writes touch ONLY these. ───────────────────
const ADAM_UID = "8fEwIduUrzxZsblHHsNz" // +14243201960 — in SCHEDULING_DEV_UIDS
const ADAM_E164 = "+14243201960"
const TEST_JOB_ID = "dev-hitl-sched-test-software_engineering"
const SESSION_ID = `dev-hitl-sched-${ADAM_UID}-${TEST_JOB_ID}`
const PRESCREEN_SESSIONS = "pa-prescreen-sessions"
const MATCHING_JOBS = "matching-jobs"

const ADMIN_AUTH = { uid: "script:hitl-to-scheduling-harness", token: { admin: true as const } }

const argv = new Set(process.argv.slice(2))
const CLEANUP = argv.has("--cleanup")
const SEND_SMS = argv.has("--send-sms")

const GREEN = (s: string) => `\x1b[32m${s}\x1b[0m`
const RED = (s: string) => `\x1b[31m${s}\x1b[0m`
const log = (...a: unknown[]) => console.log("[hitl-sched]", ...a)

function nowIso() {
  return new Date().toISOString()
}

function attemptId(): string {
  return createEvaluationAttemptId({
    source: "prescreen",
    candidateId: ADAM_UID,
    jobId: TEST_JOB_ID,
    prescreenSessionId: SESSION_ID,
  })
}

function seedAttempt(now: string): EvaluationAttempt {
  return {
    schemaVersion: 1,
    attemptId: attemptId(),
    source: "prescreen",
    purpose: "employment_prescreen",
    candidateId: ADAM_UID,
    jobId: TEST_JOB_ID,
    prescreenSessionId: SESSION_ID,
    rubricVersion: "prescreen-config-v1",
    algorithmVersion: "screening-eval-harness",
    evaluator: { kind: "hybrid", promptVersion: "hitl-sched-harness" },
    dimensions: [],
    gates: [],
    weightedFitScore: 0.9,
    evidenceConfidence: 0.9,
    missingEvidence: [],
    riskFlags: [],
    proposedOutcome: { kind: "pass", prescreenTerminal: "PASS" },
    reviewPriority: "normal",
    explanation: "HITL->scheduling harness seed: PASS pending human review.",
    evidence: [],
    humanReview: { status: "pending" },
    createdAt: now,
    updatedAt: now,
  }
}

function ctx(db: Firestore): ClaireToolContext {
  return {
    db,
    userId: ADAM_UID,
    sessionId: SESSION_ID,
    lang: "en",
    transport: {} as ClaireToolContext["transport"],
    judgeModel: "hitl-sched-harness",
    toE164: ADAM_E164,
    log: (event, payload) => log("tool", event, payload ?? {}),
    nowIso,
  }
}

// ── doc ids this harness owns (for cleanup). ────────────────────────────────
// Covers the primary docs AND the deterministic append-only audit/correction
// records the real reducers emit (markFirstInterviewStarted / markPrescreenReviewPending
// / applyPassedCandidateSnapshot / saveHumanReview), so --cleanup fully un-pollutes prod.
function seededRefs(db: Firestore) {
  const snapshotId = createEmployerVisibleProfileId(TEST_JOB_ID, ADAM_UID)
  const auditEventIds = [
    // markFirstInterviewStarted -> prescreen_started event + lifecycle/candidate-job audit
    `marketplace_candidate_job_prescreen-started-${SESSION_ID}`,
    `marketplace_lifecycle_prescreen-started-${SESSION_ID}`,
    // markPrescreenReviewPending -> prescreen_review_pending event
    `marketplace_candidate_job_prescreen-review-pending-${SESSION_ID}`,
    `marketplace_lifecycle_prescreen-review-pending-${SESSION_ID}`,
    // applyPassedCandidateSnapshot -> passed + employer_snapshot_created + employer_visible
    `marketplace_candidate_job_prescreen-terminal-${SESSION_ID}-pass`,
    `marketplace_candidate_job_employer-visible-${snapshotId}`,
    `marketplace_employer_visible_${snapshotId}`,
  ]
  return [
    db.collection(PA_COLLECTIONS.evaluationAttempts).doc(attemptId()),
    db.collection(PRESCREEN_SESSIONS).doc(SESSION_ID),
    db.collection(MATCHING_JOBS).doc(TEST_JOB_ID),
    db.collection(PA_COLLECTIONS.candidateJobStates).doc(createCandidateJobStateId(ADAM_UID, TEST_JOB_ID)),
    db.collection(PA_COLLECTIONS.candidateJobMatches).doc(createCandidateJobMatchId(ADAM_UID, TEST_JOB_ID)),
    db.collection(PA_COLLECTIONS.employerVisibleProfiles).doc(snapshotId),
    db.collection("pa-interview-bookings").doc(interviewBookingDocId({ userId: ADAM_UID, jobId: TEST_JOB_ID })),
    ...auditEventIds.map((id) => db.collection(PA_COLLECTIONS.auditEvents).doc(id)),
  ]
}

async function cleanup(db: Firestore) {
  log("CLEANUP — deleting seeded test docs (scoped to", ADAM_UID, "+", TEST_JOB_ID, ")")
  let deleted = 0
  for (const ref of seededRefs(db)) {
    const snap = await ref.get()
    if (snap.exists) {
      await ref.delete()
      deleted++
      log("  deleted", ref.path)
    }
  }
  log(GREEN(`CLEANUP DONE — ${deleted} doc(s) removed.`))
}

async function run(db: Firestore): Promise<boolean> {
  const failures: string[] = []
  const ok = (cond: boolean, label: string, detail?: unknown) => {
    if (cond) log(GREEN("PASS"), label)
    else {
      log(RED("FAIL"), label, detail ?? "")
      failures.push(label)
    }
  }

  // (0) precondition.
  ok(SCHEDULING_DEV_UIDS.has(ADAM_UID), "Adam's uid is in SCHEDULING_DEV_UIDS")

  const now = nowIso()
  const attempt = seedAttempt(now)

  // (a) Seed: drive the REAL state-machine entry the prod producer uses
  // (finalizePrescreenForHumanReview): prescreen_started -> prescreen_review_pending.
  // applyPassedCandidateSnapshot enforces prescreen_passed is valid ONLY from
  // prescreen_review_pending, so this is the faithful precondition.
  log("SEED — evaluation attempt + pending-review PASS session for", ADAM_UID, "/", TEST_JOB_ID)
  await db.collection(PA_COLLECTIONS.evaluationAttempts).doc(attempt.attemptId).set(attempt, { merge: false })
  await markFirstInterviewStarted({ db, sessionId: SESSION_ID, userId: ADAM_UID, jobId: TEST_JOB_ID, occurredAt: now })
  await markPrescreenReviewPending({ db, sessionId: SESSION_ID, userId: ADAM_UID, jobId: TEST_JOB_ID, terminal: "PASS", occurredAt: now })
  await db.collection(PRESCREEN_SESSIONS).doc(SESSION_ID).set(
    {
      sessionId: SESSION_ID,
      userId: ADAM_UID,
      jobId: TEST_JOB_ID,
      e164: ADAM_E164,
      terminal: "PASS",
      terminalReason: "HITL->scheduling harness seed.",
      score: 1,
      scoreMax: 1,
      terminalActionPendingReview: true,
      evaluationAttemptId: attempt.attemptId,
      review: {
        status: "pending",
        evaluationAttemptId: attempt.attemptId,
        proposedTerminal: "PASS",
        pendingAt: now,
        updatedAt: now,
      },
      // Mark the seed so it's unmistakably a harness artifact.
      __hitlSchedHarness: true,
      updatedAt: now,
    },
    { merge: true },
  )
  // matching-jobs label source so the schedulable job renders a human label
  // (instead of the bare jobId) — proves the real resolveJobLabel join path too.
  await db.collection(MATCHING_JOBS).doc(TEST_JOB_ID).set(
    {
      jobTitle: "Software Engineer (HITL harness)",
      companyName: "WeKruit Test",
      roleFunction: ["software_engineering"],
      __hitlSchedHarness: true,
    },
    { merge: true },
  )

  // (b) BEFORE: real list should be the dev-mimic (no committed pass yet, because
  // the seed only reached prescreen_review_pending, not employer_visible).
  const before = await listSchedulableJobs(ctx(db))
  const beforeIds = before.map((j) => j.jobId)
  log("BEFORE commit, listSchedulableJobs ->", JSON.stringify(beforeIds))
  ok(!beforeIds.includes(TEST_JOB_ID), "BEFORE: test job NOT yet schedulable", beforeIds)

  // (c) COMMIT through the REAL callable body. sendSms stubbed unless --send-sms.
  const sent: Array<Record<string, unknown>> = []
  const deps = SEND_SMS
    ? { db, now: () => now }
    : {
        db,
        now: () => now,
        sendSms: async (args: Record<string, unknown>) => {
          sent.push(args)
          log("(stubbed SMS — NOT sent)", { to: args.to, runtimeSource: args.runtimeSource })
          return { outboundId: "harness-stub-out", created: true } as never
        },
      }
  log("COMMIT — runReviewEvaluationAttempt status=approved", SEND_SMS ? "(--send-sms: REAL SMS WILL FIRE)" : "(SMS stubbed)")
  const result = await runReviewEvaluationAttempt(
    {
      attemptId: attempt.attemptId,
      status: "approved",
      finalOutcome: { prescreenTerminal: "PASS" },
      candidateMessageBody:
        "Great news — WeKruit reviewed your first screen and wants to move you forward to the next step.",
      decisionReason: "Harness commit: strong, direct ownership in the screen.",
      recommendedActions: ["Watch for the next WeKruit text."],
    },
    ADMIN_AUTH,
    deps as Parameters<typeof runReviewEvaluationAttempt>[2],
  )
  ok(result.prescreenOutcomeCommitted === true, "commit reports prescreenOutcomeCommitted=true", result)
  if (!SEND_SMS) ok(sent.length === 1, "exactly one (stubbed) decision SMS captured", sent.length)

  // (d) Assert commit side effects on REAL docs.
  const sess = (await db.collection(PRESCREEN_SESSIONS).doc(SESSION_ID).get()).data() ?? {}
  ok(sess.terminalActionPendingReview === false, "session.terminalActionPendingReview flipped to false", sess.terminalActionPendingReview)
  ok((sess.review as Record<string, unknown> | undefined)?.status === "approved", "session.review.status == approved")

  const snapshotId = createEmployerVisibleProfileId(TEST_JOB_ID, ADAM_UID)
  const snapSnap = await db.collection(PA_COLLECTIONS.employerVisibleProfiles).doc(snapshotId).get()
  ok(snapSnap.exists, `employer-visible profile ${snapshotId} EXISTS`)
  const snap = snapSnap.data() ?? {}
  ok(snap.candidateId === ADAM_UID && snap.jobId === TEST_JOB_ID, "snapshot keyed to Adam + test job")

  const stateSnap = await db.collection(PA_COLLECTIONS.candidateJobStates).doc(createCandidateJobStateId(ADAM_UID, TEST_JOB_ID)).get()
  ok(stateSnap.data()?.state === "employer_visible", "candidate-job state == employer_visible", stateSnap.data()?.state)

  // (e) THE LINKAGE: committed TEST job is now schedulable; dev-mimic is gone.
  const after = await listSchedulableJobs(ctx(db))
  const afterIds = after.map((j) => j.jobId)
  log("AFTER commit, listSchedulableJobs ->", JSON.stringify(after))
  ok(afterIds.includes(TEST_JOB_ID), "AFTER: committed TEST job IS schedulable (commit->scheduling linkage)", afterIds)
  ok(!afterIds.includes("dev-metavoice-swe") && !afterIds.includes("dev-helium-design"), "dev-mimic suppressed once a real pass exists", afterIds)

  const summary = `${failures.length === 0 ? GREEN("ALL GREEN") : RED(`${failures.length} RED`)} — ` +
    `commit->scheduling linkage ${failures.length === 0 ? "PROVEN" : "NOT proven"}.`
  log(summary)
  if (failures.length) log(RED("failures:"), failures)
  return failures.length === 0
}

async function main() {
  if (!getApps().length) initializeApp({ credential: applicationDefault(), projectId: "wekruit-5f89b" })
  const db = getFirestore()
  // Mirror the deployed functions runtime (apps/functions/src/index.ts:425) so this
  // harness exercises the SAME Firestore behavior the live paReviewEvaluationAttempt
  // CF does — otherwise a stricter client would reject undefined fields the deployed
  // CF tolerates (e.g. humanReview.note), giving a false RED.
  try {
    db.settings({ ignoreUndefinedProperties: true })
  } catch {
    /* settings() throws once getFirestore() is used — safe to ignore */
  }
  if (CLEANUP) {
    await cleanup(db)
    process.exit(0)
  }
  const green = await run(db)
  log("")
  log("Seeded docs remain in prod for the guided live test. Run with --cleanup to remove them:")
  log("  node --import tsx apps/functions/scripts/hitl-to-scheduling-harness.ts --cleanup")
  process.exit(green ? 0 : 1)
}

main().catch((err) => {
  console.error("[hitl-sched] FATAL:", err)
  process.exit(1)
})
