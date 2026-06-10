import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { HttpsError } from "firebase-functions/v2/https"
import { MockFirestore, asFirestore } from "../job-rec/__tests__/mock-firestore.js"
import { runAdminRecruiterSubmissionAction } from "../admin-recruiter-submission-action.js"

const now = "2026-06-09T12:00:00.000Z"
const later = "2026-06-09T13:00:00.000Z"
const SUBMISSIONS = "pa-recruiter-submissions"

async function seedSubmission(mfs: MockFirestore, overrides?: Record<string, unknown>): Promise<void> {
  await mfs.collection(SUBMISSIONS).doc("sub-1").set({
    submissionId: "sub-1",
    jobId: "job-1",
    candidate: { name: "Yue H", link: "https://www.linkedin.com/in/yue-h" },
    status: "submitted",
    statusHistory: [{ status: "submitted", by: "recruiter", atIso: "2026-06-08T00:00:00.000Z" }],
    ...overrides,
  })
}

async function readDoc(mfs: MockFirestore): Promise<Record<string, unknown>> {
  return (await mfs.collection(SUBMISSIONS).doc("sub-1").get()).data() ?? {}
}

function run(
  mfs: MockFirestore,
  input: Record<string, unknown>,
  opts?: { now?: string; actorEmail?: string },
): ReturnType<typeof runAdminRecruiterSubmissionAction> {
  return runAdminRecruiterSubmissionAction(input, {
    db: asFirestore(mfs),
    now: () => opts?.now ?? now,
    ...(opts && "actorEmail" in opts ? { actorEmail: opts.actorEmail } : { actorEmail: "admin1@wekruit.com" }),
  })
}

describe("runAdminRecruiterSubmissionAction", () => {
  it("advance sets status=advanced + adminDecision and appends statusHistory", async () => {
    const mfs = new MockFirestore()
    await seedSubmission(mfs)

    const result = await run(mfs, { submissionId: "sub-1", action: "advance", note: "great profile" })

    assert.deepEqual(result, { ok: true, submissionId: "sub-1", status: "advanced" })
    const doc = await readDoc(mfs)
    assert.equal(doc.status, "advanced")
    assert.deepEqual(doc.adminDecision, { by: "admin1@wekruit.com", at: now, note: "great profile" })
    const history = doc.statusHistory as Array<Record<string, unknown>>
    assert.equal(history.length, 2)
    assert.deepEqual(history[1], { status: "advanced", by: "admin", atIso: now })
    assert.equal(doc.updatedAt, now)
  })

  it("reject / reviewing / duplicate map to their statuses", async () => {
    for (const [action, status] of [
      ["reject", "rejected"],
      ["reviewing", "reviewing"],
      ["duplicate", "duplicate"],
    ] as const) {
      const mfs = new MockFirestore()
      await seedSubmission(mfs)

      const result = await run(mfs, { submissionId: "sub-1", action })

      assert.deepEqual(result, { ok: true, submissionId: "sub-1", status })
      const doc = await readDoc(mfs)
      assert.equal(doc.status, status)
      assert.deepEqual(doc.adminDecision, { by: "admin1@wekruit.com", at: now })
    }
  })

  it("wekruit_interview / client_review / hired set status to the action name", async () => {
    for (const action of ["wekruit_interview", "client_review", "hired"] as const) {
      const mfs = new MockFirestore()
      await seedSubmission(mfs)

      const result = await run(mfs, { submissionId: "sub-1", action, note: "moving along" })

      assert.deepEqual(result, { ok: true, submissionId: "sub-1", status: action })
      const doc = await readDoc(mfs)
      assert.equal(doc.status, action)
      assert.deepEqual(doc.adminDecision, { by: "admin1@wekruit.com", at: now, note: "moving along" })
      const history = doc.statusHistory as Array<Record<string, unknown>>
      assert.equal(history.length, 2)
      assert.deepEqual(history[1], { status: action, by: "admin", atIso: now })
    }
  })

  it("pipeline progression appends history submitted → wekruit_interview → client_review → hired", async () => {
    const mfs = new MockFirestore()
    await seedSubmission(mfs)

    await run(mfs, { submissionId: "sub-1", action: "wekruit_interview" })
    await run(mfs, { submissionId: "sub-1", action: "client_review" }, { now: later })
    await run(mfs, { submissionId: "sub-1", action: "hired" }, { now: later })

    const doc = await readDoc(mfs)
    assert.equal(doc.status, "hired")
    const history = doc.statusHistory as Array<Record<string, unknown>>
    assert.deepEqual(
      history.map((entry) => entry.status),
      ["submitted", "wekruit_interview", "client_review", "hired"],
    )
  })

  it("re-applying a pipeline action is idempotent: first decidedAt kept, no history dup", async () => {
    const mfs = new MockFirestore()
    await seedSubmission(mfs)

    await run(mfs, { submissionId: "sub-1", action: "wekruit_interview", note: "scheduled" })
    const result = await run(
      mfs,
      { submissionId: "sub-1", action: "wekruit_interview", note: "rescheduled" },
      { now: later, actorEmail: "admin2@wekruit.com" },
    )

    assert.deepEqual(result, { ok: true, submissionId: "sub-1", status: "wekruit_interview" })
    const doc = await readDoc(mfs)
    assert.equal(doc.status, "wekruit_interview")
    assert.deepEqual(doc.adminDecision, { by: "admin1@wekruit.com", at: now, note: "rescheduled" })
    assert.equal((doc.statusHistory as unknown[]).length, 2)
    assert.equal(doc.updatedAt, later)
  })

  it("request_info keeps/sets status reviewing and appends requestedInfo entries", async () => {
    const mfs = new MockFirestore()
    await seedSubmission(mfs)

    const first = await run(mfs, {
      submissionId: "sub-1",
      action: "request_info",
      requestMessage: "Please share the candidate's visa status.",
    })
    assert.deepEqual(first, { ok: true, submissionId: "sub-1", status: "reviewing" })
    let doc = await readDoc(mfs)
    assert.equal(doc.status, "reviewing")
    assert.deepEqual(doc.requestedInfo, [
      { message: "Please share the candidate's visa status.", at: now, by: "admin1@wekruit.com" },
    ])
    assert.equal((doc.statusHistory as unknown[]).length, 2)
    assert.equal(doc.adminDecision, undefined)

    const second = await run(
      mfs,
      { submissionId: "sub-1", action: "request_info", requestMessage: "And current compensation?" },
      { now: later },
    )
    assert.deepEqual(second, { ok: true, submissionId: "sub-1", status: "reviewing" })
    doc = await readDoc(mfs)
    assert.equal(doc.status, "reviewing")
    const requested = doc.requestedInfo as Array<Record<string, unknown>>
    assert.equal(requested.length, 2)
    assert.deepEqual(requested[1], { message: "And current compensation?", at: later, by: "admin1@wekruit.com" })
    // No second statusHistory append once already reviewing.
    assert.equal((doc.statusHistory as unknown[]).length, 2)
  })

  it("re-applying the same action is idempotent: first decidedAt kept, note updated, no history dup", async () => {
    const mfs = new MockFirestore()
    await seedSubmission(mfs)

    await run(mfs, { submissionId: "sub-1", action: "advance", note: "first pass" })
    const result = await run(
      mfs,
      { submissionId: "sub-1", action: "advance", note: "second look, still yes" },
      { now: later, actorEmail: "admin2@wekruit.com" },
    )

    assert.deepEqual(result, { ok: true, submissionId: "sub-1", status: "advanced" })
    const doc = await readDoc(mfs)
    assert.equal(doc.status, "advanced")
    assert.deepEqual(doc.adminDecision, {
      by: "admin1@wekruit.com",
      at: now,
      note: "second look, still yes",
    })
    assert.equal((doc.statusHistory as unknown[]).length, 2)
    assert.equal(doc.updatedAt, later)
  })

  it("re-apply without a note keeps the existing note", async () => {
    const mfs = new MockFirestore()
    await seedSubmission(mfs)

    await run(mfs, { submissionId: "sub-1", action: "reject", note: "wrong stack" })
    await run(mfs, { submissionId: "sub-1", action: "reject" }, { now: later })

    const doc = await readDoc(mfs)
    assert.deepEqual(doc.adminDecision, { by: "admin1@wekruit.com", at: now, note: "wrong stack" })
  })

  it("a different action after a decision moves status and rewrites the decision", async () => {
    const mfs = new MockFirestore()
    await seedSubmission(mfs)

    await run(mfs, { submissionId: "sub-1", action: "reviewing" })
    await run(mfs, { submissionId: "sub-1", action: "advance", note: "cleared" }, { now: later })

    const doc = await readDoc(mfs)
    assert.equal(doc.status, "advanced")
    assert.deepEqual(doc.adminDecision, { by: "admin1@wekruit.com", at: later, note: "cleared" })
    const history = doc.statusHistory as Array<Record<string, unknown>>
    assert.deepEqual(history.map((entry) => entry.status), ["submitted", "reviewing", "advanced"])
  })

  it("falls back to admin_token as decidedBy when no auth email is present", async () => {
    const mfs = new MockFirestore()
    await seedSubmission(mfs)

    await run(mfs, { submissionId: "sub-1", action: "advance" }, { actorEmail: undefined })

    const doc = await readDoc(mfs)
    assert.deepEqual(doc.adminDecision, { by: "admin_token", at: now })
  })

  it("rejects invalid input with invalid-argument", async () => {
    const mfs = new MockFirestore()
    await seedSubmission(mfs)

    for (const input of [
      {},
      { submissionId: "  ", action: "advance" },
      { submissionId: "sub-1", action: "approve" },
      { submissionId: "sub-1", action: "request_info" },
      { submissionId: "sub-1", action: "request_info", requestMessage: "   " },
    ]) {
      await assert.rejects(
        () => run(mfs, input),
        (err) => err instanceof HttpsError && err.code === "invalid-argument",
      )
    }
  })

  it("missing submission throws not-found", async () => {
    const mfs = new MockFirestore()

    await assert.rejects(
      () => run(mfs, { submissionId: "sub-404", action: "advance" }),
      (err) => err instanceof HttpsError && err.code === "not-found",
    )
  })

  it("never sends email or touches non-status fields", async () => {
    const mfs = new MockFirestore()
    await seedSubmission(mfs, { candidateConsentStatus: "recruiter_asserted" })

    await run(mfs, { submissionId: "sub-1", action: "duplicate" })

    const doc = await readDoc(mfs)
    assert.equal(doc.candidateConsentStatus, "recruiter_asserted")
    assert.deepEqual(doc.candidate, { name: "Yue H", link: "https://www.linkedin.com/in/yue-h" })
    const write = mfs.writeLog.at(-1)!
    assert.equal(write.mode, "merge")
    assert.deepEqual(Object.keys(write.data).sort(), ["adminDecision", "status", "statusHistory", "updatedAt"])
  })
})
