import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { MockFirestore, asFirestore } from "../job-rec/__tests__/mock-firestore.js"
import {
  AdminRecruiterSubmissionsListInputSchema,
  runAdminRecruiterSubmissionsList,
} from "../admin-recruiter-submissions-list.js"

describe("AdminRecruiterSubmissionsListInputSchema", () => {
  it("accepts empty + null adminToken", () => {
    assert.equal(AdminRecruiterSubmissionsListInputSchema.safeParse({}).success, true)
    assert.equal(AdminRecruiterSubmissionsListInputSchema.safeParse({ adminToken: null }).success, true)
  })
})

describe("runAdminRecruiterSubmissionsList", () => {
  it("returns EVERY submission incl. ones missing createdAt, coerces timestamps", async () => {
    const mfs = new MockFirestore()
    await mfs.collection("pa-recruiter-submissions").doc("s1").set({
      status: "submitted",
      recruiterId: "rec-1",
      recruiterEmail: "r@x.com",
      submitter: { name: "Rec", email: "r@x.com" },
      candidate: {
        name: "Cand A",
        email: "a@x.com",
        link: "https://example.com/cand-a",
        linkedinUrl: "https://linkedin.com/in/cand-a",
        resumeUrl: "https://storage.example.com/cand-a.pdf",
      },
      createdAt: { seconds: 1_700_000_000 },
      recruiterFeedbackUpdatedAt: { seconds: 1_700_000_100 },
      adminCommentCount: 2,
      adminLastCommentAt: { seconds: 1_700_000_200 },
      adminDecision: { by: "admin@wekruit.com", at: "2026-06-01T00:00:00.000Z" },
      requestedInfo: [{ message: "Can you send the resume?", at: "2026-06-01T00:00:00.000Z" }],
    })
    await mfs.collection("pa-recruiter-submissions").doc("s2").set({
      status: "rejected",
      candidate: { name: "Cand B" },
      // NO createdAt — must still be returned (orderBy would have dropped it).
    })
    await mfs.collection("pa-recruiter-submissions").doc("s3").set({
      status: "wekruit_interview",
      candidate: { name: "Cand C" },
      createdAt: "2026-06-01T00:00:00.000Z",
    })

    const r = await runAdminRecruiterSubmissionsList({ db: asFirestore(mfs) })
    assert.equal(r.total, 3)
    assert.equal(r.truncated, false)
    const byId = new Map(r.rows.map((row) => [(row as { id: string }).id, row]))
    // all three states present (the whole point — not just "submitted")
    assert.equal((byId.get("s1") as { status: string }).status, "submitted")
    assert.equal((byId.get("s1") as { recruiterId: string }).recruiterId, "rec-1")
    assert.equal((byId.get("s1") as { recruiterEmail: string }).recruiterEmail, "r@x.com")
    assert.deepEqual(
      (byId.get("s1") as { recruiterFeedbackUpdatedAt: unknown }).recruiterFeedbackUpdatedAt,
      { seconds: 1_700_000_100 },
    )
    assert.deepEqual(
      (byId.get("s1") as { candidate: unknown }).candidate,
      {
        name: "Cand A",
        email: "a@x.com",
        link: "https://example.com/cand-a",
        linkedinUrl: "https://linkedin.com/in/cand-a",
        resumeUrl: "https://storage.example.com/cand-a.pdf",
      },
    )
    assert.equal((byId.get("s1") as { adminCommentCount: number }).adminCommentCount, 2)
    assert.deepEqual((byId.get("s1") as { adminLastCommentAt: unknown }).adminLastCommentAt, { seconds: 1_700_000_200 })
    assert.deepEqual(
      (byId.get("s1") as { adminDecision: unknown }).adminDecision,
      { by: "admin@wekruit.com", at: "2026-06-01T00:00:00.000Z" },
    )
    assert.deepEqual(
      (byId.get("s1") as { requestedInfo: unknown }).requestedInfo,
      [{ message: "Can you send the resume?", at: "2026-06-01T00:00:00.000Z" }],
    )
    assert.equal((byId.get("s2") as { status: string }).status, "rejected")
    assert.equal((byId.get("s3") as { status: string }).status, "wekruit_interview")
    // createdAt coerced to {seconds} (back-compatible with the client)
    assert.deepEqual((byId.get("s1") as { createdAt: unknown }).createdAt, { seconds: 1_700_000_000 })
    assert.equal((byId.get("s2") as { createdAt: unknown }).createdAt, null)
    assert.deepEqual(
      (byId.get("s3") as { createdAt: { seconds: number } }).createdAt,
      { seconds: Math.floor(Date.parse("2026-06-01T00:00:00.000Z") / 1000) },
    )
  })
})
