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

  it("reject requires structured category, reusable tier, and reason", async () => {
    const mfs = new MockFirestore()
    await seedSubmission(mfs)

    for (const input of [
      { submissionId: "sub-1", action: "reject" },
      { submissionId: "sub-1", action: "reject", rejection: { category: "quality", candidateTier: "tier_1" } },
      { submissionId: "sub-1", action: "reject", rejection: { category: "unknown", candidateTier: "tier_1", reason: "weak" } },
      { submissionId: "sub-1", action: "reject", rejection: { category: "quality", candidateTier: "tier_4", reason: "weak" } },
    ]) {
      await assert.rejects(
        () => run(mfs, input),
        (err) => err instanceof HttpsError && err.code === "invalid-argument",
      )
    }
  })

  it("reject stores why, reusable tier, and a global tracked candidate record", async () => {
    const mfs = new MockFirestore()
    await seedSubmission(mfs, {
      recruiterId: "rec-1",
      recruiterEmail: "sloane@agency.com",
      candidate: {
        name: "Yue H",
        email: "yue@example.com",
        link: "https://www.linkedin.com/in/yue-h",
        linkedinUrl: "https://www.linkedin.com/in/yue-h?trk=public_profile",
        currentRole: "Staff Product Engineer",
      },
    })

    const result = await run(mfs, {
      submissionId: "sub-1",
      action: "reject",
      rejection: {
        category: "role_fit",
        candidateTier: "tier_1",
        reason: "Great engineer, but this role needs direct fintech infra experience.",
      },
    })

    assert.deepEqual(result, { ok: true, submissionId: "sub-1", status: "rejected" })
    const doc = await readDoc(mfs)
    assert.equal(doc.status, "rejected")
    assert.deepEqual(doc.adminDecision, {
      by: "admin1@wekruit.com",
      at: now,
      note: "Great engineer, but this role needs direct fintech infra experience.",
    })
    assert.deepEqual(doc.rejection, {
      category: "role_fit",
      candidateTier: "tier_1",
      reusableForOtherCompanies: true,
      reason: "Great engineer, but this role needs direct fintech infra experience.",
      by: "admin1@wekruit.com",
      at: now,
    })
    assert.equal(doc.recruiterFeedbackNote, "Great engineer, but this role needs direct fintech infra experience.")
    assert.equal(doc.recruiterFeedbackRating, 3)
    assert.deepEqual(doc.recruiterFeedbackReasons, ["role_fit", "tier_1_reusable"])

    const users = mfs.store.get("pa-users")
    assert.equal(users?.size, 1)
    const [candidateId, user] = [...users!.entries()][0]!
    assert.equal(user.candidateLifecycleState, "prospect")
    assert.equal(user.linkedinUrl, "https://linkedin.com/in/yue-h")
    assert.equal(user.email, "yue@example.com")
    assert.deepEqual(user.recruiterSubmissionDisposition, {
      lastSubmissionId: "sub-1",
      lastStatus: "rejected",
      lastRejectionCategory: "role_fit",
      candidateTier: "tier_1",
      reusableForOtherCompanies: true,
      lastRejectionReason: "Great engineer, but this role needs direct fintech infra experience.",
      updatedAt: now,
    })

    const handles = mfs.store.get("pa-candidate-handles")
    assert.equal(handles?.size, 1)
    const handle = [...handles!.values()][0]!
    assert.equal(handle.kind, "linkedin")
    assert.equal(handle.candidateId, candidateId)
    assert.equal(handle.normalizedValue, "https://linkedin.com/in/yue-h")

    const events = mfs.store.get("pa-recruiter-candidate-events")
    assert.equal(events?.size, 1)
    const event = [...events!.values()][0]!
    assert.equal(event.kind, "recruiter_submission_rejected")
    assert.equal(event.candidateId, candidateId)
    assert.equal(event.reusableForOtherCompanies, true)
    assert.equal(event.rejectionCategory, "role_fit")
    assert.equal(event.candidateTier, "tier_1")
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

  it("non-reject re-apply without a note keeps the existing note", async () => {
    const mfs = new MockFirestore()
    await seedSubmission(mfs)

    await run(mfs, { submissionId: "sub-1", action: "advance", note: "strong signal" })
    await run(mfs, { submissionId: "sub-1", action: "advance" }, { now: later })

    const doc = await readDoc(mfs)
    assert.deepEqual(doc.adminDecision, { by: "admin1@wekruit.com", at: now, note: "strong signal" })
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

  it("comment creates a by:wekruit doc in the comments subcollection and returns its id", async () => {
    const mfs = new MockFirestore()
    await seedSubmission(mfs)

    const result = await run(mfs, {
      submissionId: "sub-1",
      action: "comment",
      message: "  Looks strong — moving to intro call.  ",
    })

    assert.equal(result.ok, true)
    assert.equal(result.submissionId, "sub-1")
    assert.ok("commentId" in result)
    assert.ok(typeof result.commentId === "string" && result.commentId.length > 0)
    const comments = await mfs.collection(SUBMISSIONS).doc("sub-1").collection("comments").get()
    assert.equal(comments.size, 1)
    assert.equal(comments.docs[0].id, result.commentId)
    assert.deepEqual(comments.docs[0].data(), {
      message: "Looks strong — moving to intro call.",
      by: "wekruit",
      authorName: "admin1",
      authorEmail: "admin1@wekruit.com",
      at: now,
    })
  })

  it("comment leaves the submission doc fully untouched", async () => {
    const mfs = new MockFirestore()
    await seedSubmission(mfs, { adminDecision: { by: "admin1@wekruit.com", at: "2026-06-08T01:00:00.000Z" } })
    const before = await readDoc(mfs)

    await run(mfs, { submissionId: "sub-1", action: "comment", message: "ping" })

    const after = await readDoc(mfs)
    assert.deepEqual(after, before)
    assert.equal(after.status, "submitted")
    assert.equal((after.statusHistory as unknown[]).length, 1)
    assert.equal(after.updatedAt, undefined)
    assert.equal(mfs.writeLog.length, 2)
    const write = mfs.writeLog.at(-1)!
    assert.equal(write.path, "pa-recruiter-submissions/sub-1/comments")
    assert.equal(write.mode, "set")
    assert.deepEqual(Object.keys(write.data).sort(), ["at", "authorEmail", "authorName", "by", "message"])
  })

  it("comment message validation: missing / blank / over 4000 chars rejected, exactly 4000 after trim accepted", async () => {
    const mfs = new MockFirestore()
    await seedSubmission(mfs)

    for (const input of [
      { submissionId: "sub-1", action: "comment" },
      { submissionId: "sub-1", action: "comment", message: "   " },
      { submissionId: "sub-1", action: "comment", message: 42 },
      { submissionId: "sub-1", action: "comment", message: "x".repeat(4_001) },
    ]) {
      await assert.rejects(
        () => run(mfs, input),
        (err) => err instanceof HttpsError && err.code === "invalid-argument",
      )
    }
    let comments = await mfs.collection(SUBMISSIONS).doc("sub-1").collection("comments").get()
    assert.equal(comments.size, 0)

    const result = await run(mfs, {
      submissionId: "sub-1",
      action: "comment",
      message: `  ${"x".repeat(4_000)}  `,
    })
    assert.equal(result.ok, true)
    comments = await mfs.collection(SUBMISSIONS).doc("sub-1").collection("comments").get()
    assert.equal(comments.size, 1)
    assert.equal((comments.docs[0].data() as { message: string }).message.length, 4_000)
  })

  it("comment without an auth email falls back to authorName WeKruit and omits authorEmail", async () => {
    const mfs = new MockFirestore()
    await seedSubmission(mfs)

    await run(mfs, { submissionId: "sub-1", action: "comment", message: "hello" }, { actorEmail: undefined })

    const comments = await mfs.collection(SUBMISSIONS).doc("sub-1").collection("comments").get()
    assert.equal(comments.size, 1)
    assert.deepEqual(comments.docs[0].data(), {
      message: "hello",
      by: "wekruit",
      authorName: "WeKruit",
      at: now,
    })
  })

  it("repeated comments append distinct docs, never overwrite", async () => {
    const mfs = new MockFirestore()
    await seedSubmission(mfs)

    const first = await run(mfs, { submissionId: "sub-1", action: "comment", message: "first" })
    const second = await run(mfs, { submissionId: "sub-1", action: "comment", message: "second" }, { now: later })

    assert.ok("commentId" in first && "commentId" in second)
    assert.notEqual(first.commentId, second.commentId)
    const comments = await mfs.collection(SUBMISSIONS).doc("sub-1").collection("comments").get()
    assert.equal(comments.size, 2)
    assert.deepEqual(
      comments.docs.map((d) => (d.data() as { message: string }).message).sort(),
      ["first", "second"],
    )
  })

  it("comment on a missing submission throws not-found and writes nothing", async () => {
    const mfs = new MockFirestore()

    await assert.rejects(
      () => run(mfs, { submissionId: "sub-404", action: "comment", message: "hello" }),
      (err) => err instanceof HttpsError && err.code === "not-found",
    )
    assert.equal(mfs.writeLog.length, 0)
  })
})
