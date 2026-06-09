import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { HttpsError } from "firebase-functions/v2/https"
import { PA_COLLECTIONS } from "@pa/core-types"
import { MockFirestore, asFirestore } from "../job-rec/__tests__/mock-firestore.js"
import {
  runAdminIdentityConflicts,
  type AdminIdentityConflictsCountsResult,
  type AdminIdentityConflictsResolveResult,
} from "../admin-identity-conflicts.js"

const now = "2026-06-09T12:00:00.000Z"
const CONFLICTS = PA_COLLECTIONS.candidateIdentityConflicts

async function seedConflicts(mfs: MockFirestore): Promise<void> {
  await mfs.collection(CONFLICTS).doc("c-open-email").set({
    conflictId: "c-open-email",
    kind: "handle_candidate_mismatch",
    status: "open",
    primaryCandidateId: "cand-a",
    competingCandidateId: "cand-b",
    handleKind: "email",
    createdAt: "2026-06-08T01:00:00.000Z",
  })
  await mfs.collection(CONFLICTS).doc("c-open-browser").set({
    conflictId: "c-open-browser",
    kind: "handle_candidate_mismatch",
    status: "open",
    primaryCandidateId: "cand-b",
    competingCandidateId: "cand-a",
    handleKind: "browser_uid",
    createdAt: "2026-06-08T01:00:00.000Z",
  })
  await mfs.collection(CONFLICTS).doc("c-resolved").set({
    conflictId: "c-resolved",
    kind: "handle_candidate_mismatch",
    status: "resolved",
    handleKind: "phone",
    resolvedAt: "2026-06-07T00:00:00.000Z",
    resolvedBy: "admin1@wekruit.com",
    createdAt: "2026-06-06T00:00:00.000Z",
  })
  await mfs.collection(CONFLICTS).doc("c-no-status").set({
    conflictId: "c-no-status",
    kind: "duplicate_suspicion",
    createdAt: "2026-06-05T00:00:00.000Z",
  })
}

async function run(
  mfs: MockFirestore,
  input: Record<string, unknown>,
  actorEmail?: string,
): Promise<AdminIdentityConflictsResolveResult | AdminIdentityConflictsCountsResult> {
  return runAdminIdentityConflicts(input, { db: asFirestore(mfs), now: () => now, actorEmail })
}

describe("runAdminIdentityConflicts", () => {
  it("rejects invalid input with invalid-argument", async () => {
    const mfs = new MockFirestore()
    const invalidInputs: unknown[] = [
      {},
      { action: "nope" },
      { action: "resolve" },
      { action: "resolve", conflictIds: [], status: "resolved" },
      { action: "resolve", conflictIds: ["a"], status: "open" },
      { action: "resolve", conflictIds: Array.from({ length: 201 }, (_, i) => `c-${i}`), status: "resolved" },
    ]
    for (const input of invalidInputs) {
      await assert.rejects(
        () => runAdminIdentityConflicts(input, { db: asFirestore(mfs), now: () => now }),
        (err) => err instanceof HttpsError && err.code === "invalid-argument",
      )
    }
  })

  it("resolve updates status, resolvedAt, resolvedBy, and resolutionNote", async () => {
    const mfs = new MockFirestore()
    await seedConflicts(mfs)

    const result = await run(
      mfs,
      { action: "resolve", conflictIds: ["c-open-email", "c-open-browser"], status: "dismissed", note: "same laptop, two accounts" },
      "admin1@wekruit.com",
    )

    assert.deepEqual(result, { ok: true, action: "resolve", status: "dismissed", updated: 2, skipped: 0 })
    const doc = (await mfs.collection(CONFLICTS).doc("c-open-email").get()).data()!
    assert.equal(doc.status, "dismissed")
    assert.equal(doc.resolvedAt, now)
    assert.equal(doc.resolvedBy, "admin1@wekruit.com")
    assert.equal(doc.resolutionNote, "same laptop, two accounts")
    assert.equal(doc.updatedAt, now)
    assert.equal(doc.kind, "handle_candidate_mismatch", "merge update preserves existing fields")
  })

  it("resolve falls back to admin_token actor and omits resolutionNote when no note given", async () => {
    const mfs = new MockFirestore()
    await seedConflicts(mfs)

    const result = await run(mfs, { action: "resolve", conflictIds: ["c-no-status"], status: "resolved" })

    assert.deepEqual(result, { ok: true, action: "resolve", status: "resolved", updated: 1, skipped: 0 })
    const doc = (await mfs.collection(CONFLICTS).doc("c-no-status").get()).data()!
    assert.equal(doc.status, "resolved")
    assert.equal(doc.resolvedBy, "admin_token")
    assert.equal("resolutionNote" in doc, false)
  })

  it("resolve is idempotent: docs already in the target status and missing docs are skipped", async () => {
    const mfs = new MockFirestore()
    await seedConflicts(mfs)

    const first = await run(mfs, { action: "resolve", conflictIds: ["c-open-email"], status: "resolved" }, "admin1@wekruit.com")
    assert.deepEqual(first, { ok: true, action: "resolve", status: "resolved", updated: 1, skipped: 0 })

    const second = await run(
      mfs,
      { action: "resolve", conflictIds: ["c-open-email", "c-resolved", "c-missing"], status: "resolved" },
      "admin2@wekruit.com",
    )
    assert.deepEqual(second, { ok: true, action: "resolve", status: "resolved", updated: 0, skipped: 3 })

    const doc = (await mfs.collection(CONFLICTS).doc("c-open-email").get()).data()!
    assert.equal(doc.resolvedBy, "admin1@wekruit.com", "skip must not overwrite the original resolver")
  })

  it("resolve can flip a dismissed conflict back to resolved (status change is an update, not a skip)", async () => {
    const mfs = new MockFirestore()
    await seedConflicts(mfs)
    await run(mfs, { action: "resolve", conflictIds: ["c-open-email"], status: "dismissed" })

    const result = await run(mfs, { action: "resolve", conflictIds: ["c-open-email"], status: "resolved" })
    assert.deepEqual(result, { ok: true, action: "resolve", status: "resolved", updated: 1, skipped: 0 })
  })

  it("counts returns total, byStatus (missing status counted as open), and byHandleKind", async () => {
    const mfs = new MockFirestore()
    await seedConflicts(mfs)

    const result = await run(mfs, { action: "counts" })

    assert.deepEqual(result, {
      ok: true,
      action: "counts",
      total: 4,
      byStatus: { open: 3, resolved: 1 },
      byHandleKind: { email: 1, browser_uid: 1, phone: 1, unknown: 1 },
    })
  })

  it("counts reflects resolve writes", async () => {
    const mfs = new MockFirestore()
    await seedConflicts(mfs)
    await run(mfs, { action: "resolve", conflictIds: ["c-open-email", "c-open-browser"], status: "dismissed" })

    const result = (await run(mfs, { action: "counts" })) as AdminIdentityConflictsCountsResult
    assert.deepEqual(result.byStatus, { open: 1, resolved: 1, dismissed: 2 })
    assert.equal(result.total, 4)
  })
})
