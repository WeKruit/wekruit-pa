import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { HttpsError } from "firebase-functions/v2/https"
import { classifyPrescreenReviewRow, PA_COLLECTIONS } from "@pa/core-types"
import type {
  PrescreenOpsSnapshotOpsResponse,
  PrescreenOpsSnapshotSessionsResponse,
} from "@pa/core-types"
import { MockFirestore, asFirestore } from "../job-rec/__tests__/mock-firestore.js"
import { runAdminPrescreenOpsSnapshot } from "../admin-prescreen-ops.js"

const now = "2026-06-09T12:00:00.000Z"
const PRESCREEN_SESSIONS = "pa-prescreen-sessions"

const strongQuestions = {
  q_growth_marketing_experience: {
    qId: "q_growth_marketing_experience",
    type: "MUST_HAVE",
    finalS: 0.97,
    finalC: 0.9,
    scored: {
      aggregate: {
        summary: "Owned lifecycle campaigns end-to-end and increased qualified signups by 38%.",
      },
    },
  },
}

async function seedFixtures(mfs: MockFirestore): Promise<void> {
  await mfs.collection(PA_COLLECTIONS.users).doc("cand-a").set({
    phoneE164: "+14155550101",
    piiConsentAt: now,
  })
  await mfs.collection(PA_COLLECTIONS.users).doc("cand-b").set({
    phoneE164: "+14155550102",
    piiConsentAt: now,
  })
  await mfs.collection(PA_COLLECTIONS.users).doc("qa-bot").set({
    phoneE164: "+14155550999",
    testMode: true,
  })

  await mfs.collection(PA_COLLECTIONS.jobs).doc("job-a").set({
    title: "Growth Marketer",
    company: "Acme",
    status: "active",
  })
  await mfs.collection(PA_COLLECTIONS.jobs).doc("job-b").set({
    jobTitle: "Product Designer",
    companyName: "Invoko",
  })

  await mfs.collection(PRESCREEN_SESSIONS).doc("s-pending").set({
    userId: "cand-a",
    jobId: "job-a",
    terminal: "FAIL",
    terminalReason: "below threshold",
    score: 1,
    scoreMax: 3,
    threshold: 2.4,
    terminalActionPendingReview: true,
    createdAt: "2026-06-08T06:00:00.000Z",
  })
  await mfs.collection(PRESCREEN_SESSIONS).doc("s-committed").set({
    userId: "cand-a",
    jobId: "job-a",
    terminal: "PASS",
    score: 3,
    scoreMax: 3,
    terminalActionFiredAt: "2026-06-08T05:30:00.000Z",
    review: { status: "committed", finalTerminal: "PASS" },
    questions: strongQuestions,
    createdAt: "2026-06-08T05:00:00.000Z",
  })
  await mfs.collection(PRESCREEN_SESSIONS).doc("s-stranded").set({
    userId: "cand-b",
    jobId: "job-b",
    terminal: "FAIL",
    score: 1,
    scoreMax: 3,
    createdAt: "2026-06-08T04:00:00.000Z",
  })
  await mfs.collection(PRESCREEN_SESSIONS).doc("s-auto").set({
    userId: "cand-b",
    jobId: "job-b",
    terminal: "PASS",
    score: 3,
    scoreMax: 3,
    terminalActionFiredAt: "2026-06-08T03:30:00.000Z",
    createdAt: "2026-06-08T03:00:00.000Z",
  })
  await mfs.collection(PRESCREEN_SESSIONS).doc("s-paused").set({
    userId: "cand-a",
    jobId: "job-a",
    terminal: "PAUSE",
    score: 1.4,
    scoreMax: 3,
    createdAt: "2026-06-08T02:00:00.000Z",
  })
  await mfs.collection(PRESCREEN_SESSIONS).doc("s-inprog").set({
    userId: "cand-a",
    jobId: "job-a",
    terminal: null,
    score: 0,
    scoreMax: 3,
    createdAt: "2026-06-08T01:00:00.000Z",
  })
  await mfs.collection(PRESCREEN_SESSIONS).doc("s-testuser").set({
    userId: "qa-bot",
    jobId: "job-a",
    terminal: "PASS",
    score: 3,
    scoreMax: 3,
    createdAt: "2026-06-08T00:00:00.000Z",
  })
}

async function runOps(mfs: MockFirestore, input: Record<string, unknown>): Promise<PrescreenOpsSnapshotOpsResponse> {
  const result = await runAdminPrescreenOpsSnapshot(input, { db: asFirestore(mfs), now: () => now })
  return result as PrescreenOpsSnapshotOpsResponse
}

async function runSessions(
  mfs: MockFirestore,
  input: Record<string, unknown>,
): Promise<PrescreenOpsSnapshotSessionsResponse> {
  const result = await runAdminPrescreenOpsSnapshot(input, { db: asFirestore(mfs), now: () => now })
  return result as PrescreenOpsSnapshotSessionsResponse
}

describe("runAdminPrescreenOpsSnapshot", () => {
  it("rejects invalid input with invalid-argument", async () => {
    const mfs = new MockFirestore()
    await assert.rejects(
      () => runAdminPrescreenOpsSnapshot({}, { db: asFirestore(mfs), now: () => now }),
      (err) => err instanceof HttpsError && err.code === "invalid-argument",
    )
    await assert.rejects(
      () => runAdminPrescreenOpsSnapshot({ mode: "nope" }, { db: asFirestore(mfs), now: () => now }),
      (err) => err instanceof HttpsError && err.code === "invalid-argument",
    )
  })

  it("ops mode computes exact totals with test sessions counted separately", async () => {
    const mfs = new MockFirestore()
    await seedFixtures(mfs)

    const result = await runOps(mfs, { mode: "ops" })

    assert.equal(result.generatedAt, now)
    assert.equal(result.scanned, 7)
    assert.equal(result.truncated, false)
    assert.equal(result.totals.sessions, 7)
    assert.equal(result.totals.realSessions, 6)
    assert.equal(result.totals.testSessions, 1)
    assert.deepEqual(result.totals.byTerminal, { PASS: 2, FAIL: 2, HARD_STOP: 0, PAUSE: 1, IN_PROGRESS: 1 })
    assert.equal(result.totals.inProgress, 1)
    assert.equal(result.totals.pendingHumanReview, 1)
    assert.deepEqual(result.totals.committed, { PASS: 1, FAIL: 0, HARD_STOP: 0 })
    assert.equal(result.totals.autoFinalizedNoReview, 1)
    assert.equal(result.totals.strandedNoReview, 1)
    assert.deepEqual(result.totals.byBucket, {
      top_five_pass: 1,
      batch_reject: 4,
      individual_review: 0,
      hard_stop: 0,
      paused: 1,
    })
  })

  it("ops mode includeTest folds test sessions into the KPI counts", async () => {
    const mfs = new MockFirestore()
    await seedFixtures(mfs)

    const result = await runOps(mfs, { mode: "ops", includeTest: true })

    assert.equal(result.totals.realSessions, 6)
    assert.equal(result.totals.testSessions, 1)
    assert.deepEqual(result.totals.byTerminal, { PASS: 3, FAIL: 2, HARD_STOP: 0, PAUSE: 1, IN_PROGRESS: 1 })
  })

  it("ops mode rolls up per job with tolerant metadata reads, sorted by lastSessionAt", async () => {
    const mfs = new MockFirestore()
    await seedFixtures(mfs)

    const result = await runOps(mfs, { mode: "ops" })

    assert.deepEqual(result.jobs.map((job) => job.jobId), ["job-a", "job-b"])
    const [jobA, jobB] = result.jobs
    assert.equal(jobA!.title, "Growth Marketer")
    assert.equal(jobA!.company, "Acme")
    assert.equal(jobA!.jobStatus, "active")
    assert.equal(jobA!.sessionCount, 5)
    assert.equal(jobA!.realSessionCount, 4)
    assert.equal(jobA!.testSessionCount, 1)
    assert.equal(jobA!.pendingReview, 1)
    assert.deepEqual(jobA!.committed, { PASS: 1, FAIL: 0, HARD_STOP: 0 })
    assert.equal(jobA!.autoFinalized, 0)
    assert.equal(jobA!.stranded, 0)
    assert.equal(jobA!.byBucket.top_five_pass, 1)
    assert.equal(jobA!.byBucket.paused, 1)
    assert.equal(jobA!.lastSessionAt, "2026-06-08T06:00:00.000Z")

    assert.equal(jobB!.title, "Product Designer")
    assert.equal(jobB!.company, "Invoko")
    assert.equal(jobB!.jobStatus, "unknown")
    assert.equal(jobB!.sessionCount, 2)
    assert.equal(jobB!.realSessionCount, 2)
    assert.equal(jobB!.testSessionCount, 0)
    assert.equal(jobB!.autoFinalized, 1)
    assert.equal(jobB!.stranded, 1)
    assert.deepEqual(jobB!.byTerminal, { PASS: 1, FAIL: 1, HARD_STOP: 0, PAUSE: 0, IN_PROGRESS: 0 })
  })

  it("sessions mode derives reviewState per row and excludes test sessions by default", async () => {
    const mfs = new MockFirestore()
    await seedFixtures(mfs)

    const withTest = await runSessions(mfs, { mode: "sessions", jobId: "job-a", includeTest: true, limit: 10 })
    const states = new Map(withTest.rows.map((row) => [row.id, row.reviewState]))
    assert.equal(states.get("s-pending"), "pending")
    assert.equal(states.get("s-committed"), "committed")
    assert.equal(states.get("s-paused"), "paused")
    assert.equal(states.get("s-inprog"), "in_progress")
    assert.equal(withTest.rows.find((row) => row.id === "s-testuser")?.candidateClass, "synthetic_test_profile")
    assert.equal(withTest.rows.find((row) => row.id === "s-pending")?.candidateClass, "candidate_account")
    assert.equal(withTest.rows.find((row) => row.id === "s-pending")?.terminalReason, "below threshold")
    assert.equal(withTest.rows.find((row) => row.id === "s-pending")?.threshold, 2.4)

    const realOnly = await runSessions(mfs, { mode: "sessions", jobId: "job-a", limit: 10 })
    assert.deepEqual(realOnly.rows.map((row) => row.id), ["s-pending", "s-committed", "s-paused", "s-inprog"])

    const jobB = await runSessions(mfs, { mode: "sessions", jobId: "job-b", limit: 10 })
    const jobBStates = new Map(jobB.rows.map((row) => [row.id, row.reviewState]))
    assert.equal(jobBStates.get("s-stranded"), "stranded")
    assert.equal(jobBStates.get("s-auto"), "auto_finalized")
  })

  it("sessions mode supports pending queue at the query layer and committed queue in-memory", async () => {
    const mfs = new MockFirestore()
    await seedFixtures(mfs)

    const pending = await runSessions(mfs, { mode: "sessions", queue: "pending", includeTest: true, limit: 10 })
    assert.deepEqual(pending.rows.map((row) => row.id), ["s-pending"])

    const committed = await runSessions(mfs, {
      mode: "sessions",
      jobId: "job-a",
      queue: "committed",
      includeTest: true,
      limit: 10,
    })
    assert.deepEqual(committed.rows.map((row) => row.id), ["s-committed"])
  })

  it("sessions mode bucket filter matches the shared classification bit-for-bit", async () => {
    const mfs = new MockFirestore()
    await seedFixtures(mfs)

    const result = await runSessions(mfs, {
      mode: "sessions",
      jobId: "job-a",
      bucket: "top_five_pass",
      includeTest: true,
      limit: 10,
    })

    assert.deepEqual(result.rows.map((row) => row.id), ["s-committed"])
    const expected = classifyPrescreenReviewRow({
      terminal: "PASS",
      score: 3,
      scoreMax: 3,
      questions: strongQuestions,
    })
    assert.equal(result.rows[0]!.classification.bucket, expected.bucket)
    assert.equal(result.rows[0]!.classification.label, expected.label)
    assert.deepEqual(result.rows[0]!.classification.reasons, expected.reasons)
    assert.ok(result.rows[0]!.questions)
  })

  it("sessions mode pagination cursor walks every session exactly once", async () => {
    const mfs = new MockFirestore()
    await seedFixtures(mfs)

    const seen: string[] = []
    let cursor: { createdAt: string; docId: string } | undefined
    let pages = 0
    for (;;) {
      const page = await runSessions(mfs, {
        mode: "sessions",
        jobId: "job-a",
        includeTest: true,
        limit: 2,
        ...(cursor ? { cursor } : {}),
      })
      seen.push(...page.rows.map((row) => row.id))
      pages += 1
      if (!page.nextCursor) break
      cursor = page.nextCursor
      assert.ok(pages < 10, "cursor walk did not terminate")
    }

    assert.equal(pages, 3)
    assert.deepEqual(seen, ["s-pending", "s-committed", "s-paused", "s-inprog", "s-testuser"])
  })
})
